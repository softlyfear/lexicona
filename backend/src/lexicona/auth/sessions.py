"""Session snapshots and explicit persistence, using the inherited short UoW."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from time import monotonic
from typing import Literal, cast
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from lexicona.auth.bootstrap import utc_now
from lexicona.auth.config import token, token_hash
from lexicona.auth.errors import AuthError, Decision
from lexicona.auth.values import epoch_microseconds
from lexicona.database import SCHEMA_REVISION, Database

P_US = 1800 * 1000000
IDLE_US = 7 * 86400 * 1000000
ABS_US = 30 * 86400 * 1000000
TOUCH_US = 300 * 1000000


@dataclass(frozen=True, repr=False)
class Session:
    id: str
    user_id: str | None
    csrf: str
    last_seen: int
    expires: int
    absolute: int

    @property
    def principal(self) -> str:
        """The marker belongs to this DB decision, not the current cookie jar."""
        return "anonymous" if self.user_id is None else "user:" + self.user_id

    def authenticated_id(self) -> str:
        """Require A without a second unreachable nullable-user guard."""
        if self.user_id is None:
            raise AuthError("auth_required")
        return self.user_id


@dataclass(frozen=True, repr=False)
class PreparedSession:
    id: str
    secret: str
    csrf: str


@dataclass(frozen=True, repr=False)
class IssuedSession(PreparedSession):
    absolute: int


@dataclass(frozen=True, repr=False)
class User:
    id: str
    login: str
    display_name: str
    role: Literal["user", "admin"]
    version: int
    encoded: str
    active: bool


class Sessions:
    """Read validity on every request; never update a pre-auth row in place."""

    def __init__(
        self,
        database: Database,
        *,
        clock: Callable[[], datetime] = utc_now,
        ids: Callable[[], UUID] = uuid4,
        tokens: Callable[[], str] = token,
    ) -> None:
        self.database = database
        self.clock = clock
        self.ids = ids
        self.tokens = tokens

    def now(self) -> int:
        """Take a fresh server timestamp inside the final serialized guard."""
        return epoch_microseconds(self.clock())

    def prepare(self) -> PreparedSession:
        """Prepare random material outside the writer lock."""
        return PreparedSession(str(self.ids()), self.tokens(), self.tokens())

    async def resolve(
        self, db: AsyncSession, digest: bytes | None, now: int
    ) -> Session | None:
        """One snapshot checks revocation, both deadlines and current activity."""
        revision = (
            (await db.execute(text("SELECT version_num FROM alembic_version")))
            .scalars()
            .all()
        )
        if revision != [SCHEMA_REVISION]:
            raise AuthError("service_unavailable")
        row = (
            await db.execute(
                text("""SELECT s.id,s.user_id,s.csrf_token,s.last_seen_at,
            s.expires_at,s.absolute_expires_at FROM auth_sessions s
            LEFT JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=:digest AND s.revoked_at IS NULL
            AND s.expires_at>:now AND s.absolute_expires_at>:now
            AND (s.user_id IS NULL OR u.is_active=1)"""),
                {"digest": digest, "now": now},
            )
        ).one_or_none()
        if row is None:
            return None
        return Session(
            str(row[0]), row[1], str(row[2]), int(row[3]), int(row[4]), int(row[5])
        )

    async def insert(
        self,
        db: AsyncSession,
        prepared: PreparedSession,
        now: int,
        user: str | None = None,
    ) -> None:
        """Set all session columns explicitly; the cookie itself is never stored."""
        await db.execute(
            text("""INSERT INTO auth_sessions
            (id,user_id,token_hash,csrf_token,created_at,last_seen_at,expires_at,absolute_expires_at,revoked_at)
            VALUES (:id,:user,:digest,:csrf,:now,:now,:expires,:absolute,NULL)"""),
            {
                "id": prepared.id,
                "user": user,
                "digest": token_hash(prepared.secret),
                "csrf": prepared.csrf,
                "now": now,
                "expires": now + (P_US if user is None else IDLE_US),
                "absolute": now + (P_US if user is None else ABS_US),
            },
        )

    def budget(self, context: Decision) -> None:
        """Do not submit another operation after the response budget expires."""
        if monotonic() >= context.deadline:
            raise AuthError("request_timeout")

    async def required(
        self,
        db: AsyncSession,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session], None],
    ) -> Session:
        """Re-resolve validity before authorization, including inside final write."""
        self.budget(context)
        context.principal = "anonymous"
        current = await self.resolve(db, digest, self.now())
        if current is None:
            raise AuthError("auth_required")
        context.principal = current.principal
        authorize(current)
        return current

    async def check(
        self,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session], None],
    ) -> None:
        """No metadata effects before unsafe preconditions and body validation."""
        async with self.database.unit_of_work(deadline=context.deadline) as db:
            await self.required(db, context, digest, authorize)

    async def user(self, db: AsyncSession, login: str) -> User | None:
        """Take an immutable credential snapshot, never an ORM response."""
        row = (
            await db.execute(
                text("""SELECT id,login,display_name,role,version,
            password_hash,is_active FROM users WHERE login=:login"""),
                {"login": login},
            )
        ).one_or_none()
        if row is None:
            return None
        return User(
            str(row[0]),
            str(row[1]),
            str(row[2]),
            cast(Literal["user", "admin"], row[3]),
            int(row[4]),
            str(row[5]),
            bool(row[6]),
        )

    async def candidate(self, context: Decision, login: str) -> User | None:
        """Release the read transaction before expensive verification."""
        async with self.database.unit_of_work(deadline=context.deadline) as db:
            return await self.user(db, login)

    async def revoke(
        self,
        db: AsyncSession,
        context: Decision,
        digest: bytes | None,
        current: Session,
        now: int,
    ) -> None:
        """Revoke exactly the still-valid credential, using a conditional write."""
        self.budget(context)
        changed = await db.scalar(
            text("""UPDATE auth_sessions SET revoked_at=:now
            WHERE id=:id AND token_hash=:digest AND revoked_at IS NULL
            AND expires_at>:now AND absolute_expires_at>:now RETURNING id"""),
            {"id": current.id, "digest": digest, "now": now},
        )
        if changed != current.id:
            context.principal = "anonymous"
            raise AuthError("auth_required")

    async def login(
        self,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session], None],
        candidate: User,
    ) -> tuple[User, IssuedSession]:
        """Recheck credential version/PHC and rotate P to A in one write UoW."""
        self.budget(context)
        prepared = self.prepare()
        async with self.database.unit_of_work(
            write=True, deadline=context.deadline
        ) as db:
            current = await self.required(db, context, digest, authorize)
            user = await self.user(db, candidate.login)
            if (
                user is None
                or not user.active
                or user.id != candidate.id
                or user.version != candidate.version
                or user.encoded != candidate.encoded
            ):
                raise AuthError("invalid_credentials")
            now = self.now()
            live = (
                (
                    await db.execute(
                        text("""SELECT id FROM auth_sessions
                WHERE user_id=:user AND revoked_at IS NULL AND expires_at>:now
                AND absolute_expires_at>:now ORDER BY created_at,id"""),
                        {"user": user.id, "now": now},
                    )
                )
                .scalars()
                .all()
            )
            for old in live[:-4]:
                self.budget(context)
                await db.execute(
                    text("UPDATE auth_sessions SET revoked_at=:now WHERE id=:id"),
                    {"id": old, "now": now},
                )
            await self.revoke(db, context, digest, current, now)
            self.budget(context)
            await self.insert(db, prepared, now, user.id)
            self.budget(context)
        self.budget(context)
        return user, IssuedSession(
            prepared.id, prepared.secret, prepared.csrf, now + ABS_US
        )

    async def by_id(self, db: AsyncSession, id: str) -> User:
        """Fetch safe user fields in the same transaction as the session guard."""
        row = (
            await db.execute(
                text("""SELECT id,login,display_name,role,version,
            password_hash,is_active FROM users WHERE id=:id AND is_active=1"""),
                {"id": id},
            )
        ).one()
        return User(
            str(row[0]),
            str(row[1]),
            str(row[2]),
            cast(Literal["user", "admin"], row[3]),
            int(row[4]),
            str(row[5]),
            bool(row[6]),
        )

    async def me(
        self, context: Decision, digest: bytes | None, validate: Callable[[], None]
    ) -> User:
        """Serve cookie identity; touch only at the five-minute CAS boundary."""

        def authenticated(current: Session) -> None:
            current.authenticated_id()
            validate()

        async with self.database.unit_of_work(deadline=context.deadline) as db:
            current = await self.required(db, context, digest, authenticated)
            user = await self.by_id(db, current.authenticated_id())
            due = self.now() - current.last_seen >= TOUCH_US
        if not due:
            self.budget(context)
            return user
        _, user = await self.touch(context, digest, authenticated)
        return user

    async def touch(
        self,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session], None],
        *,
        user_check: Callable[[User], None] = lambda _: None,
    ) -> tuple[Session, User]:
        """Recheck A and CAS metadata in a fresh, short serialized write."""
        self.budget(context)
        async with self.database.unit_of_work(
            write=True, deadline=context.deadline
        ) as db:
            current = await self.required(db, context, digest, authorize)
            user = await self.by_id(db, current.authenticated_id())
            user_check(user)
            now = self.now()
            if now - current.last_seen >= TOUCH_US:
                self.budget(context)
                changed = await db.scalar(
                    text("""UPDATE auth_sessions
                    SET last_seen_at=:now,expires_at=min(:expires,absolute_expires_at)
                    WHERE id=:id AND token_hash=:digest AND last_seen_at=:seen
                    AND revoked_at IS NULL AND expires_at>:now
                    AND absolute_expires_at>:now
                    AND EXISTS (SELECT 1 FROM users u
                        WHERE u.id=auth_sessions.user_id AND u.is_active=1)
                    RETURNING id"""),
                    {
                        "now": now,
                        "expires": now + IDLE_US,
                        "id": current.id,
                        "digest": digest,
                        "seen": current.last_seen,
                    },
                )
                if changed != current.id:
                    context.principal = "anonymous"
                    raise AuthError("auth_required")
            self.budget(context)
        self.budget(context)
        return current, user

    async def logout(
        self,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session], None],
        admit: Callable[[], None],
    ) -> IssuedSession:
        """Revoke old A/P and create a new P in one serialized committed rotation."""
        self.budget(context)
        prepared = self.prepare()
        async with self.database.unit_of_work(
            write=True, deadline=context.deadline
        ) as db:
            current = await self.required(db, context, digest, authorize)
            admit()
            now = self.now()
            await self.revoke(db, context, digest, current, now)
            count = await db.scalar(
                text("""SELECT count(*) FROM auth_sessions
                WHERE user_id IS NULL AND revoked_at IS NULL AND expires_at>:now"""),
                {"now": now},
            )
            if count >= 10000:
                raise AuthError("rate_limited")
            self.budget(context)
            await self.insert(db, prepared, now)
            self.budget(context)
        self.budget(context)
        return IssuedSession(prepared.id, prepared.secret, prepared.csrf, now + P_US)

    async def csrf(
        self, context: Decision, digest: bytes | None, admit: Callable[[], None]
    ) -> tuple[Session, PreparedSession | None]:
        """Reuse a valid synchronizer token, or atomically admit a fresh P."""
        async with self.database.unit_of_work(deadline=context.deadline) as db:
            current = await self.resolve(db, digest, self.now())
        if current is not None:
            if (
                current.user_id is not None
                and self.now() - current.last_seen >= TOUCH_US
            ):
                current, _ = await self.touch(context, digest, lambda _: None)
            return current, None
        prepared = self.prepare()
        async with self.database.unit_of_work(
            write=True, deadline=context.deadline
        ) as db:
            now = self.now()
            current = await self.resolve(db, digest, now)
            if current is not None:
                return current, None
            admit()
            await db.execute(
                text("""DELETE FROM auth_sessions WHERE id IN (
                SELECT id FROM auth_sessions WHERE user_id IS NULL
                AND (expires_at<=:now OR revoked_at IS NOT NULL)
                ORDER BY expires_at,id LIMIT 500)"""),
                {"now": now},
            )
            count = await db.scalar(
                text("""SELECT count(*) FROM auth_sessions
                WHERE user_id IS NULL AND revoked_at IS NULL AND expires_at>:now"""),
                {"now": now},
            )
            if count >= 10000:
                raise AuthError("rate_limited")
            await self.insert(db, prepared, now)
        # The row may have committed even when response preparation has become
        # stale. Never send a credential whose absolute lifetime already ended.
        if self.now() >= now + P_US:
            raise AuthError("auth_required")
        self.budget(context)
        return Session(
            prepared.id, None, prepared.csrf, now, now + P_US, now + P_US
        ), prepared

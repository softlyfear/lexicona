"""Invite registration and administration on the accepted native write UoW."""

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from lexicona.auth.config import token_hash
from lexicona.auth.dto import InviteDTO, InviteListDTO, RegisterDTO
from lexicona.auth.errors import AuthError, Decision
from lexicona.auth.pagination import Page, encode
from lexicona.auth.sessions import (
    ABS_US,
    TOUCH_US,
    IssuedSession,
    Session,
    Sessions,
    User,
)

INVITE_US = 72 * 3600 * 1000000


class _LoginConflict(Exception):
    """Only users.login UNIQUE, isolated to its INSERT; never a commit failure."""


@dataclass(frozen=True, repr=False)
class Invite:
    id: str
    digest: bytes
    created_by: str | None
    created: int
    expires: int
    used: int | None
    revoked: int | None
    version: int

    def dto(self, now: int) -> InviteDTO:
        """Only administrative metadata, never recipient or credential material."""
        return InviteDTO(
            id=UUID(self.id),
            created_by=None if self.created_by is None else UUID(self.created_by),
            created_at=timestamp(self.created),
            expires_at=timestamp(self.expires),
            used_at=None if self.used is None else timestamp(self.used),
            revoked_at=None if self.revoked is None else timestamp(self.revoked),
            state=(
                "used"
                if self.used is not None
                else "revoked"
                if self.revoked is not None
                else "expired"
                if now >= self.expires
                else "active"
            ),
            version=self.version,
        )


def timestamp(value: int) -> str:
    """Exact integer UTC conversion with six microsecond digits."""
    return (datetime(1970, 1, 1, tzinfo=UTC) + timedelta(microseconds=value)).strftime(
        "%Y-%m-%dT%H:%M:%S.%fZ"
    )


class Invites:
    """One owner of invite state; no new tables or transaction implementation."""

    def __init__(self, sessions: Sessions) -> None:
        self.sessions = sessions

    async def admin(
        self,
        db: AsyncSession,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session, User], None],
    ) -> tuple[Session, User]:
        """Current activity and role come from the same DB authorization read."""

        def authenticated(current: Session) -> None:
            current.authenticated_id()

        current = await self.sessions.required(db, context, digest, authenticated)
        user = await self.sessions.by_id(db, current.authenticated_id())
        authorize(current, user)
        return current, user

    async def check_admin(
        self,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session, User], None],
    ) -> None:
        """Unsafe preliminary guards have no touch or business effects."""
        async with self.sessions.database.unit_of_work(deadline=context.deadline) as db:
            await self.admin(db, context, digest, authorize)

    async def create(
        self,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session, User], None],
        admit: Callable[[User, int | None], None],
    ) -> tuple[InviteDTO, str]:
        """Prepare credentials before locking; issue only after known commit."""
        self.sessions.budget(context)
        id, secret = str(self.sessions.ids()), self.sessions.tokens()
        hashed = token_hash(secret)
        async with self.sessions.database.unit_of_work(
            write=True, deadline=context.deadline
        ) as db:
            _, user = await self.admin(db, context, digest, authorize)
            now = self.sessions.now()
            count, earliest = (
                await db.execute(
                    text("""SELECT count(*),min(expires_at)
                FROM invites WHERE used_at IS NULL AND revoked_at IS NULL
                AND expires_at>:now"""),
                    {"now": now},
                )
            ).one()
            capacity_retry = (
                max(1, (int(earliest) - now + 999999) // 1000000)
                if count >= 100
                else None
            )
            admit(user, capacity_retry)
            invite = Invite(id, hashed, user.id, now, now + INVITE_US, None, None, 1)
            self.sessions.budget(context)
            await db.execute(
                text("""INSERT INTO invites
                (id,token_hash,created_by,created_at,expires_at,used_at,revoked_at,used_by,version)
                VALUES (:id,:hash,:admin,:now,:expires,NULL,NULL,NULL,1)"""),
                {
                    "id": id,
                    "hash": hashed,
                    "admin": user.id,
                    "now": now,
                    "expires": invite.expires,
                },
            )
            self.sessions.budget(context)
        self.sessions.budget(context)
        return invite.dto(now), secret

    async def list(
        self,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session, User], None],
        pagination: Callable[[], Page],
    ) -> InviteListDTO:
        """Read the full administrative list, ordered by stable descending keyset."""
        async with self.sessions.database.unit_of_work(deadline=context.deadline) as db:
            current, _ = await self.admin(db, context, digest, authorize)
            page = pagination()
            now = self.sessions.now()
            due = now - current.last_seen >= TOUCH_US
            parameters: dict[str, object] = {"limit": page.limit + 1}
            where = ""
            if page.position is not None:
                where = "WHERE (created_at,id)<(:created,:id)"
                parameters.update(created=page.position[0], id=page.position[1])
            rows = (
                await db.execute(
                    text(
                        """SELECT id,token_hash,created_by,
                created_at,expires_at,used_at,revoked_at,version FROM invites """
                        + where
                        + " ORDER BY created_at DESC,id DESC LIMIT :limit"
                    ),
                    parameters,
                )
            ).all()
            items = [
                Invite(
                    str(row[0]),
                    bytes(row[1]),
                    row[2],
                    int(row[3]),
                    int(row[4]),
                    row[5],
                    row[6],
                    int(row[7]),
                )
                for row in rows[: page.limit]
            ]
            cursor = (
                encode(items[-1].created, items[-1].id)
                if len(rows) > page.limit
                else None
            )
            result = InviteListDTO(
                items=[item.dto(now) for item in items], next_cursor=cursor
            )
        if due:

            def admin_role(user: User) -> None:
                if user.role != "admin":
                    raise AuthError("forbidden")

            await self.sessions.touch(
                context, digest, lambda _: None, user_check=admin_role
            )
        self.sessions.budget(context)
        return result

    async def valid(self, db: AsyncSession, digest: bytes, now: int) -> tuple[str, int]:
        """Reject all unknown, used, expired and revoked invites identically."""
        row = (
            await db.execute(
                text("""SELECT id,version FROM invites
            WHERE token_hash=:hash AND used_at IS NULL AND revoked_at IS NULL
            AND expires_at>:now"""),
                {"hash": digest, "now": now},
            )
        ).one_or_none()
        if row is None:
            raise AuthError("invite_invalid")
        return str(row[0]), int(row[1])

    async def candidate(self, context: Decision, digest: bytes, login: str) -> None:
        """Do not disclose duplicate login until a valid invite has been checked."""
        async with self.sessions.database.unit_of_work(deadline=context.deadline) as db:
            await self.valid(db, digest, self.sessions.now())
            if await self.sessions.user(db, login) is not None:
                raise AuthError(
                    "login_unavailable", fields={"login": ["Логин недоступен."]}
                )

    async def register(
        self,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session], None],
        data: RegisterDTO,
        encoded: str,
    ) -> tuple[User, IssuedSession]:
        """User/settings/consume/P revoke/new A share one IMMEDIATE commit."""
        self.sessions.budget(context)
        user_id, prepared = str(self.sessions.ids()), self.sessions.prepare()
        hashed = token_hash(data.invite_token)
        try:
            async with self.sessions.database.unit_of_work(
                write=True, deadline=context.deadline
            ) as db:
                current = await self.sessions.required(db, context, digest, authorize)
                now = self.sessions.now()
                invite_id, version = await self.valid(db, hashed, now)
                if await self.sessions.user(db, data.login) is not None:
                    raise AuthError(
                        "login_unavailable", fields={"login": ["Логин недоступен."]}
                    )
                self.sessions.budget(context)
                try:
                    await db.execute(
                        text("""INSERT INTO users
                        (id,login,display_name,password_hash,role,is_active,version,created_at,updated_at)
                        VALUES (:id,:login,:name,:hash,'user',1,1,:now,:now)"""),
                        {
                            "id": user_id,
                            "login": data.login,
                            "name": data.display_name,
                            "hash": encoded,
                            "now": now,
                        },
                    )
                except IntegrityError as error:
                    # This statement's only UNIQUE (not PRIMARY KEY) constraint is
                    # login. Other constraints, later writes and commit errors keep
                    # their native failure semantics; do not infer rollback there.
                    if (
                        getattr(error.orig, "sqlite_errorcode", 0)
                        != sqlite3.SQLITE_CONSTRAINT_UNIQUE
                    ):
                        raise
                    raise _LoginConflict() from None
                self.sessions.budget(context)
                await db.execute(
                    text("""INSERT INTO user_settings
                    (user_id,timezone,theme,daily_goal,speech_rate,english_locale,version,created_at,updated_at)
                    VALUES (:id,'UTC','dark',10,1.0,'en-US',1,:now,:now)"""),
                    {"id": user_id, "now": now},
                )
                self.sessions.budget(context)
                changed = await db.scalar(
                    text("""UPDATE invites SET used_at=:now,
                    used_by=:user,version=version+1 WHERE id=:id AND token_hash=:hash
                    AND version=:version AND used_at IS NULL AND revoked_at IS NULL
                    AND expires_at>:now RETURNING id"""),
                    {
                        "id": invite_id,
                        "hash": hashed,
                        "version": version,
                        "now": now,
                        "user": user_id,
                    },
                )
                if changed != invite_id:
                    raise AuthError("invite_invalid")
                await self.sessions.revoke(db, context, digest, current, now)
                self.sessions.budget(context)
                await self.sessions.insert(db, prepared, now, user_id)
                self.sessions.budget(context)
        except _LoginConflict:
            # The UoW has now joined native rollback. Re-read invite validity at
            # fresh server time before disclosing anything about the login.
            async with self.sessions.database.unit_of_work(
                deadline=context.deadline
            ) as db:
                await self.valid(db, hashed, self.sessions.now())
            raise AuthError(
                "login_unavailable", fields={"login": ["Логин недоступен."]}
            ) from None
        self.sessions.budget(context)
        return User(
            user_id, data.login, data.display_name, "user", 1, encoded, True
        ), IssuedSession(prepared.id, prepared.secret, prepared.csrf, now + ABS_US)

    async def revoke(
        self,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session, User], None],
        id: str,
        version: int,
    ) -> InviteDTO:
        """Expected version precedes state; current revoked state is idempotent."""
        self.sessions.budget(context)
        async with self.sessions.database.unit_of_work(
            write=True, deadline=context.deadline
        ) as db:
            await self.admin(db, context, digest, authorize)
            now = self.sessions.now()
            row = (
                await db.execute(
                    text("""SELECT id,token_hash,created_by,
                created_at,expires_at,used_at,revoked_at,version FROM invites
                WHERE id=:id"""),
                    {"id": id},
                )
            ).one_or_none()
            if row is None:
                raise AuthError("not_found")
            invite = Invite(
                str(row[0]),
                bytes(row[1]),
                row[2],
                int(row[3]),
                int(row[4]),
                row[5],
                row[6],
                int(row[7]),
            )
            if invite.version != version:
                raise AuthError("version_conflict")
            if invite.revoked is not None:
                return invite.dto(now)
            if invite.used is not None or now >= invite.expires:
                raise AuthError("invite_state_conflict")
            self.sessions.budget(context)
            changed = await db.scalar(
                text("""UPDATE invites SET revoked_at=:now,
                version=version+1 WHERE id=:id AND version=:version
                AND used_at IS NULL AND revoked_at IS NULL AND expires_at>:now
                RETURNING id"""),
                {"id": id, "version": version, "now": now},
            )
            if changed != id:
                raise AuthError("invite_state_conflict")
            self.sessions.budget(context)
        self.sessions.budget(context)
        return Invite(
            invite.id,
            invite.digest,
            invite.created_by,
            invite.created,
            invite.expires,
            None,
            now,
            invite.version + 1,
        ).dto(now)

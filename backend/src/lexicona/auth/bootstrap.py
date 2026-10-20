"""First-admin persistence: explicit fields and one inherited IMMEDIATE UoW."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from time import monotonic
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from lexicona.auth import values
from lexicona.auth.passwords import PasswordService
from lexicona.database import SCHEMA_REVISION, Database


class BootstrapError(Exception):
    """Static operator-facing failure, without SQL or supplied input."""

    def __init__(self, exit_code: int) -> None:
        self.exit_code = exit_code
        super().__init__(
            {
                3: "Логин недоступен.",
                4: "Первоначальная настройка уже выполнена.",
                5: "База данных не готова.",
            }[exit_code]
        )


def utc_now() -> datetime:
    """Production aware UTC clock; injectable independently of IDs and hashing."""
    return datetime.now(UTC)


@dataclass(frozen=True, repr=False)
class NewAdministrator:
    id: UUID
    login: str
    display_name: str
    password_hash: str


class BootstrapService:
    """A bounded first-admin use case, not an elevation or recovery mechanism."""

    def __init__(
        self,
        database: Database,
        passwords: PasswordService,
        *,
        clock: Callable[[], datetime] = utc_now,
        ids: Callable[[], UUID] = uuid4,
    ) -> None:
        self.database = database
        self.passwords = passwords
        self.clock = clock
        self.ids = ids

    async def check(self, login: str) -> None:
        """Reject wrong schema/duplicate/any existing account before prompting."""
        if not await self.database.is_ready():
            raise BootstrapError(5)
        async with self.database.unit_of_work() as session:
            await self._guard(session, values.login(login))

    async def _guard(self, session: AsyncSession, login: str) -> None:
        revisions = (
            (await session.execute(text("SELECT version_num FROM alembic_version")))
            .scalars()
            .all()
        )
        if revisions != [SCHEMA_REVISION]:
            raise BootstrapError(5)
        if await session.scalar(
            text("SELECT 1 FROM users WHERE login=:login"), {"login": login}
        ):
            raise BootstrapError(3)
        if await session.scalar(text("SELECT 1 FROM users LIMIT 1")):
            raise BootstrapError(4)

    async def create(
        self, login: str, display_name: str, password: str, *, deadline: float
    ) -> None:
        """Prepare outside the lock, recheck inside it, return only after commit."""
        canonical = values.login(login)
        name = values.display_name(display_name)
        secret = values.password(password)
        await self.check(canonical)
        encoded = await self.passwords.hash(secret, deadline=deadline)
        self._check_deadline(deadline)
        prepared = NewAdministrator(self.ids(), canonical, name, encoded)
        async with self.database.unit_of_work(write=True) as session:
            self._check_deadline(deadline)
            await self._guard(session, canonical)
            self._check_deadline(deadline)
            now = values.epoch_microseconds(self.clock())
            await session.execute(
                text("""INSERT INTO users
                (id,login,display_name,password_hash,role,is_active,version,created_at,updated_at)
                VALUES (:id,:login,:name,:hash,'admin',1,1,:now,:now)"""),
                {
                    "id": str(prepared.id),
                    "login": prepared.login,
                    "name": prepared.display_name,
                    "hash": prepared.password_hash,
                    "now": now,
                },
            )
            self._check_deadline(deadline)
            await session.execute(
                text("""INSERT INTO user_settings
                (user_id,timezone,theme,daily_goal,speech_rate,english_locale,version,created_at,updated_at)
                VALUES (:id,'UTC','dark',10,1.0,'en-US',1,:now,:now)"""),
                {"id": str(prepared.id), "now": now},
            )
            self._check_deadline(deadline)
        # Expiry after a submitted commit is not a rollback assertion.
        self._check_deadline(deadline)

    def _check_deadline(self, deadline: float) -> None:
        if monotonic() >= deadline:
            raise BootstrapError(5)

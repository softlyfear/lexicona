"""File-backed SQLite connection policy and explicit short units of work."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from sqlalchemy import Connection, event, text
from sqlalchemy.dialects.sqlite.aiosqlite import AsyncAdapt_aiosqlite_connection
from sqlalchemy.engine import Dialect, make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import ConnectionPoolEntry

SCHEMA_REVISION = "0001_foundation"
DEFAULT_DATABASE_URL = "sqlite+aiosqlite:///./data/lexicona.sqlite3"


def configure_connection(
    connection: AsyncAdapt_aiosqlite_connection, record: ConnectionPoolEntry
) -> None:
    """Disable legacy implicit BEGIN and apply invariants on every connection."""
    connection.isolation_level = None
    cursor = connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


def begin_transaction(connection: Connection) -> None:
    """Make transactions real even for DDL, SELECT and outer savepoints."""
    connection.exec_driver_sql("BEGIN")


class Database:
    """Own the bounded connection pool, not a shared mutable session."""

    def __init__(self, database_url: str) -> None:
        url = make_url(database_url)
        if (
            url.drivername != "sqlite+aiosqlite"
            or not url.database
            or url.database == ":memory:"
            or url.query
        ):
            raise ValueError("Only file-backed sqlite+aiosqlite URLs are supported")
        self._directory = Path(url.database).parent
        self.engine = create_async_engine(
            url, pool_size=5, max_overflow=0, hide_parameters=True
        )
        event.listen(self.engine.sync_engine, "do_connect", self._prepare_directory)
        event.listen(self.engine.sync_engine, "connect", configure_connection)
        event.listen(self.engine.sync_engine, "begin", begin_transaction)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    def _prepare_directory(
        self,
        dialect: Dialect,
        record: ConnectionPoolEntry,
        args: list[object],
        kwargs: dict[str, object],
    ) -> None:
        """Retry filesystem setup at connection time, never during app creation."""
        self._directory.mkdir(mode=0o700, parents=True, exist_ok=True)

    @asynccontextmanager
    async def unit_of_work(self) -> AsyncIterator[AsyncSession]:
        """Commit one explicit transaction; roll back on any failure."""
        async with self.sessions() as session, session.begin():
            yield session

    async def is_ready(self) -> bool:
        """Probe the database and require exactly the application's schema head."""
        try:
            async with self.unit_of_work() as session:
                revisions = (
                    (
                        await session.execute(
                            text("SELECT version_num FROM alembic_version")
                        )
                    )
                    .scalars()
                    .all()
                )
                return revisions == [SCHEMA_REVISION]
        except (OSError, SQLAlchemyError):
            return False

    async def dispose(self) -> None:
        """Release all idle pooled connections."""
        await self.engine.dispose()

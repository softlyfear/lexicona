"""File-backed SQLite connection policy and explicit short units of work."""

import asyncio
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from pathlib import Path
from time import monotonic
from typing import cast

from sqlalchemy import Connection, event, text
from sqlalchemy.dialects.sqlite.aiosqlite import AsyncAdapt_aiosqlite_connection
from sqlalchemy.engine import Dialect, make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import ConnectionPoolEntry, PoolResetState

SCHEMA_REVISION = "0002_auth_core"
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
    cursor.execute("PRAGMA synchronous=FULL")
    cursor.close()


def begin_transaction(connection: Connection) -> None:
    """Make transactions real even for DDL, SELECT and outer savepoints."""
    bound_busy(connection)
    connection.exec_driver_sql(
        "BEGIN IMMEDIATE"
        if connection.get_execution_options().get("sqlite_write")
        else "BEGIN"
    )


def bound_busy(connection: Connection) -> None:
    """Bound native busy waits by the one auth admission deadline."""
    deadline = connection.get_execution_options().get("auth_deadline")
    if deadline is not None:
        remaining = cast(float, deadline) - monotonic()
        if remaining <= 0:
            raise TimeoutError()
        cursor = connection.connection.cursor()
        cursor.execute(f"PRAGMA busy_timeout={min(5000, int(remaining * 1000))}")
        cursor.close()


def bound_statement(
    connection: Connection,
    cursor: object,
    statement: str,
    parameters: object,
    context: object,
    executemany: bool,
) -> None:
    """Refresh the native wait bound for each statement, not once per UoW."""
    bound_busy(connection)


def restore_busy(
    connection: AsyncAdapt_aiosqlite_connection,
    record: ConnectionPoolEntry,
    state: PoolResetState,
) -> None:
    """Reset a surviving connection before returning it to the shared pool."""
    if not state.terminate_only:
        cursor = connection.cursor()
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()


@asynccontextmanager
async def admission_timeout(deadline: float | None) -> AsyncIterator[None]:
    """Expire admission once, never interrupt cancellation's native cleanup.

    asyncio.timeout_at can issue a second cancellation while SQLAlchemy is
    already joining a cancelled SQLite operation. Its force-close fallback may
    then return before the queued close. An external cancellation owns that
    finalization; the admission timer must not cancel it again.
    """
    if deadline is None:
        yield
        return
    if deadline <= monotonic():
        raise TimeoutError()
    owner = asyncio.current_task()
    assert owner is not None
    cancellations = owner.cancelling()
    expired = False

    def expire() -> None:
        nonlocal expired
        if owner.cancelling() == cancellations:
            expired = True
            owner.cancel()

    timer = asyncio.get_running_loop().call_at(deadline, expire)
    try:
        yield
    except asyncio.CancelledError:
        if expired and owner.uncancel() <= cancellations:
            raise TimeoutError() from None
        raise
    finally:
        timer.cancel()


async def finalize(work: Awaitable[None]) -> None:
    """Join mandatory rollback/invalidation even if its caller is cancelled.

    Only cleanup runs in this task: never a business statement or commit.
    Cancellation is re-raised after the native finalization has really finished.
    """
    operation = asyncio.ensure_future(work)
    cancelled = False
    while not operation.done():
        try:
            await asyncio.shield(operation)
        except asyncio.CancelledError:
            cancelled = True
    operation.result()
    if cancelled:
        raise asyncio.CancelledError()


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
            url, pool_size=3, max_overflow=0, pool_timeout=5, hide_parameters=True
        )
        event.listen(self.engine.sync_engine, "do_connect", self._prepare_directory)
        event.listen(self.engine.sync_engine, "connect", configure_connection)
        event.listen(self.engine.sync_engine, "begin", begin_transaction)
        event.listen(self.engine.sync_engine, "before_cursor_execute", bound_statement)
        event.listen(self.engine.sync_engine, "commit", bound_busy)
        event.listen(self.engine.sync_engine, "reset", restore_busy)
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
    async def unit_of_work(
        self, *, write: bool = False, deadline: float | None = None
    ) -> AsyncIterator[AsyncSession]:
        """Commit or roll back one UoW; reserve write access before yielding."""
        async with admission_timeout(deadline):
            async with self.sessions() as session:
                await session.begin()
                try:
                    if write or deadline is not None:
                        await session.connection(
                            execution_options={
                                "sqlite_write": write,
                                "auth_deadline": deadline,
                            }
                        )
                    yield session
                except BaseException:
                    try:
                        await finalize(session.rollback())
                    except BaseException:
                        await finalize(session.invalidate())
                        raise
                    raise
                else:
                    try:
                        await session.commit()
                    except BaseException:
                        # A lost commit acknowledgement is not rollback proof.
                        # Invalidate before any transaction context can reset /
                        # return this uncertain connection to the shared pool.
                        await finalize(session.invalidate())
                        raise

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

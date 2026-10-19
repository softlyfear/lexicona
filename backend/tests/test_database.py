from contextlib import AsyncExitStack
from pathlib import Path
from stat import S_IMODE

import pytest
from sqlalchemy import event, text
from sqlalchemy.dialects.sqlite.aiosqlite import AsyncAdapt_aiosqlite_connection
from sqlalchemy.pool import AsyncAdaptedQueuePool, ConnectionPoolEntry


@pytest.mark.parametrize(
    "url",
    [
        "sqlite+aiosqlite:///:memory:",
        "sqlite+aiosqlite://",
        "sqlite:///relative.sqlite3",
        "postgresql+asyncpg://localhost/example",
        "sqlite+aiosqlite:///a.sqlite3?uri=true",
    ],
)
def test_only_local_file_sqlite_is_supported(url: str) -> None:
    from lexicona.database import Database

    with pytest.raises(ValueError, match="file-backed sqlite\\+aiosqlite"):
        Database(url)


async def test_file_database_configuration(tmp_path: Path) -> None:
    from lexicona.database import Database

    directory = tmp_path / "private"
    database = Database(f"sqlite+aiosqlite:///{directory / 'app.sqlite3'}")
    try:
        async with database.unit_of_work() as session:
            assert await session.scalar(text("PRAGMA journal_mode")) == "wal"
            assert await session.scalar(text("PRAGMA foreign_keys")) == 1
            assert await session.scalar(text("PRAGMA busy_timeout")) == 5000
            assert session.in_transaction()
        assert S_IMODE(directory.stat().st_mode) == 0o700
    finally:
        await database.dispose()


async def test_every_physical_connection_uses_explicit_full_synchronous(
    tmp_path: Path,
) -> None:
    from lexicona.database import Database

    database = Database(f"sqlite+aiosqlite:///{tmp_path / 'full.sqlite3'}")

    def adverse_default(
        connection: AsyncAdapt_aiosqlite_connection, record: ConnectionPoolEntry
    ) -> None:
        cursor = connection.cursor()
        cursor.execute("PRAGMA synchronous=OFF")
        cursor.close()

    event.listen(database.engine.sync_engine, "connect", adverse_default, insert=True)
    try:
        async with AsyncExitStack() as stack:
            for _ in range(3):
                connection = await stack.enter_async_context(database.engine.connect())
                assert await connection.scalar(text("PRAGMA synchronous")) == 2
                assert await connection.scalar(text("PRAGMA journal_mode")) == "wal"
                assert await connection.scalar(text("PRAGMA foreign_keys")) == 1
                assert await connection.scalar(text("PRAGMA busy_timeout")) == 5000
        # Checkouts of the same pooled connections retain the policy.
        async with database.unit_of_work() as session:
            assert await session.scalar(text("PRAGMA synchronous")) == 2
    finally:
        await database.dispose()


async def test_pool_is_three_connections_without_overflow(tmp_path: Path) -> None:
    import asyncio

    from lexicona.database import Database

    database = Database(f"sqlite+aiosqlite:///{tmp_path / 'pool.sqlite3'}")
    try:
        pool = database.engine.pool
        assert isinstance(pool, AsyncAdaptedQueuePool)
        assert pool.size() == 3
        assert pool.timeout() == 5
        async with AsyncExitStack() as stack:
            for _ in range(3):
                await stack.enter_async_context(database.engine.connect())
            assert pool.checkedout() == 3
            assert pool.overflow() == 0
            with pytest.raises(TimeoutError):
                async with asyncio.timeout(0.1):
                    async with database.engine.connect():
                        pytest.fail("Pool overflow was allowed")
        assert pool.checkedout() == 0
    finally:
        await database.dispose()

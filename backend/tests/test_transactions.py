import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from lexicona.database import Database


@pytest.fixture
async def database(tmp_path: Path) -> AsyncIterator[Database]:
    database = Database(f"sqlite+aiosqlite:///{tmp_path / 'transactions.sqlite3'}")
    async with database.unit_of_work() as session:
        await session.execute(text("CREATE TABLE probe (id INTEGER PRIMARY KEY)"))
    try:
        yield database
    finally:
        await database.dispose()


async def test_commit_and_exception_rollback(database: Database) -> None:
    async with database.unit_of_work() as session:
        await session.execute(text("INSERT INTO probe VALUES (1)"))
    with pytest.raises(RuntimeError, match="abort"):
        async with database.unit_of_work() as session:
            await session.execute(text("INSERT INTO probe VALUES (2)"))
            raise RuntimeError("abort")
    async with database.unit_of_work() as session:
        assert (
            await session.execute(text("SELECT id FROM probe"))
        ).scalars().all() == [1]


async def test_ddl_and_released_savepoint_roll_back_with_outer(
    database: Database,
) -> None:
    with pytest.raises(RuntimeError, match="abort"):
        async with database.unit_of_work() as session:
            await session.execute(text("CREATE TABLE rolled_back (id INTEGER)"))
            async with session.begin_nested():
                await session.execute(text("INSERT INTO probe VALUES (1)"))
            raise RuntimeError("abort")
    async with database.unit_of_work() as session:
        assert await session.scalar(text("SELECT count(*) FROM probe")) == 0
        assert (
            await session.scalar(
                text("SELECT count(*) FROM sqlite_master WHERE name='rolled_back'")
            )
            == 0
        )


async def test_nested_failure_preserves_outer_transaction(database: Database) -> None:
    async with database.unit_of_work() as session:
        await session.execute(text("INSERT INTO probe VALUES (1)"))
        with pytest.raises(IntegrityError):
            async with session.begin_nested():
                await session.execute(text("INSERT INTO probe VALUES (2)"))
                await session.execute(text("INSERT INTO probe VALUES (1)"))
        await session.execute(text("INSERT INTO probe VALUES (3)"))
    async with database.unit_of_work() as session:
        assert (
            await session.execute(text("SELECT id FROM probe ORDER BY id"))
        ).scalars().all() == [1, 3]


async def test_foreign_keys_are_actually_enforced(database: Database) -> None:
    async with database.unit_of_work() as session:
        await session.execute(
            text("CREATE TABLE child (parent_id INTEGER REFERENCES probe(id))")
        )
    with pytest.raises(IntegrityError):
        async with database.unit_of_work() as session:
            await session.execute(text("INSERT INTO child VALUES (999)"))
    async with database.unit_of_work() as session:
        assert await session.scalar(text("SELECT count(*) FROM child")) == 0


async def test_concurrent_connections_and_wal_reader(database: Database) -> None:
    async with database.unit_of_work() as writer:
        await writer.execute(text("INSERT INTO probe VALUES (1)"))
        async with database.unit_of_work() as reader:
            assert writer is not reader
            assert await writer.connection() is not await reader.connection()
            assert await reader.scalar(text("PRAGMA foreign_keys")) == 1
            assert await reader.scalar(text("PRAGMA busy_timeout")) == 5000
            assert await reader.scalar(text("PRAGMA journal_mode")) == "wal"
            assert await reader.scalar(text("SELECT count(*) FROM probe")) == 0
    async with database.unit_of_work() as reader:
        assert await reader.scalar(text("SELECT count(*) FROM probe")) == 1


async def test_busy_writer_waits_then_commits(database: Database) -> None:
    attempted = asyncio.Event()

    async def second_writer() -> None:
        async with database.unit_of_work() as session:
            attempted.set()
            await session.execute(text("INSERT INTO probe VALUES (2)"))

    async with asyncio.TaskGroup() as group:
        async with database.unit_of_work() as session:
            await session.execute(text("INSERT INTO probe VALUES (1)"))
            task = group.create_task(second_writer())
            await asyncio.wait_for(attempted.wait(), timeout=2)
            await asyncio.sleep(0.05)
            assert not task.done()
        await asyncio.wait_for(task, timeout=2)
    async with database.unit_of_work() as session:
        assert await session.scalar(text("SELECT count(*) FROM probe")) == 2

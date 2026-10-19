"""Bounded real SQLite contention without a speculative business retry layer."""

import asyncio
import sqlite3
from pathlib import Path
from time import monotonic

import httpx
import pytest
from alembic import command
from alembic.config import Config
from asgi_lifespan import LifespanManager
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from lexicona.app import create_app
from lexicona.database import Database


async def test_write_reservation_busy_is_bounded_atomic_and_recovers(
    tmp_path: Path,
) -> None:
    database = Database(f"sqlite+aiosqlite:///{tmp_path / 'busy.sqlite3'}")
    try:
        async with database.unit_of_work() as session:
            await session.execute(text("CREATE TABLE probe (id INTEGER PRIMARY KEY)"))
            await session.execute(text("INSERT INTO probe VALUES (1)"))
        async with database.unit_of_work(write=True) as writer:
            await writer.execute(text("INSERT INTO probe VALUES (2)"))
            async with database.unit_of_work() as reader:
                assert (
                    await reader.execute(text("SELECT id FROM probe"))
                ).scalars().all() == [1]
                entered = False
                start = monotonic()
                with pytest.raises(OperationalError) as exc:
                    async with asyncio.timeout(8):
                        async with database.unit_of_work(write=True):
                            entered = True
                assert not entered, (
                    "No application work may run before reserving the writer"
                )
                assert isinstance(exc.value.orig, sqlite3.OperationalError)
                assert exc.value.orig.sqlite_errorcode == sqlite3.SQLITE_BUSY
                assert 4.5 <= monotonic() - start < 8
                assert (
                    await reader.execute(text("SELECT id FROM probe"))
                ).scalars().all() == [1]
        async with database.unit_of_work(write=True) as recovered:
            await recovered.execute(text("INSERT INTO probe VALUES (3)"))
        async with database.unit_of_work() as session:
            assert (
                await session.execute(text("SELECT id FROM probe ORDER BY id"))
            ).scalars().all() == [1, 2, 3]
            assert await session.scalar(text("PRAGMA integrity_check")) == "ok"
    finally:
        await database.dispose()


async def test_readiness_busy_has_safe_503_retry_hint_and_recovery(
    tmp_path: Path,
) -> None:
    path = tmp_path / "exclusive.sqlite3"
    url = f"sqlite+aiosqlite:///{path}"
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", url)
    await asyncio.to_thread(command.upgrade, config, "head")
    lock = sqlite3.connect(path, isolation_level=None)
    try:
        assert lock.execute("PRAGMA journal_mode").fetchone() == ("wal",)
        lock.execute("PRAGMA locking_mode=EXCLUSIVE")
        lock.execute("BEGIN EXCLUSIVE")
        async with LifespanManager(app := create_app(url)):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                start = monotonic()
                async with asyncio.timeout(8):
                    response = await client.get("/api/v1/health/ready")
                assert 4.5 <= monotonic() - start < 8
                assert response.status_code == 503
                assert response.json() == {
                    "error": {"code": "not_ready", "message": "Service is not ready"}
                }
                assert response.headers["cache-control"] == "no-store"
                assert response.headers.get("retry-after") == "1"
                assert (await client.get("/api/v1/health/live")).status_code == 200
                lock.rollback()
                lock.close()
                recovered = await client.get("/api/v1/health/ready")
                assert recovered.status_code == 200
                assert recovered.json() == {"status": "ready"}
    finally:
        lock.close()


async def test_wal_writer_leaves_http_readiness_available(tmp_path: Path) -> None:
    url = f"sqlite+aiosqlite:///{tmp_path / 'wal-ready.sqlite3'}"
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", url)
    await asyncio.to_thread(command.upgrade, config, "head")
    database = Database(url)
    try:
        async with LifespanManager(app := create_app(url)):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                async with database.unit_of_work(write=True) as writer:
                    await writer.execute(text("CREATE TABLE pending (id INTEGER)"))
                    async with asyncio.timeout(2):
                        response = await client.get("/api/v1/health/ready")
                    assert response.status_code == 200
                    assert response.json() == {"status": "ready"}
    finally:
        await database.dispose()


async def test_exhausted_pool_readiness_is_bounded_and_recovers(tmp_path: Path) -> None:
    from contextlib import AsyncExitStack

    url = f"sqlite+aiosqlite:///{tmp_path / 'pool-ready.sqlite3'}"
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", url)
    await asyncio.to_thread(command.upgrade, config, "head")
    database = Database(url)
    try:
        async with AsyncExitStack() as stack:
            for _ in range(3):
                await stack.enter_async_context(database.engine.connect())
            start = monotonic()
            async with asyncio.timeout(8):
                assert not await database.is_ready()
            assert 4.5 <= monotonic() - start < 8
        assert await database.is_ready()
    finally:
        await database.dispose()


async def test_reserved_write_rollback_keeps_outer_savepoint_atomic(
    tmp_path: Path,
) -> None:
    database = Database(f"sqlite+aiosqlite:///{tmp_path / 'write-rollback.sqlite3'}")
    try:
        with pytest.raises(RuntimeError, match="abort"):
            async with database.unit_of_work(write=True) as writer:
                await writer.execute(text("CREATE TABLE aborted (id INTEGER)"))
                async with writer.begin_nested():
                    await writer.execute(text("INSERT INTO aborted VALUES (1)"))
                raise RuntimeError("abort")
        async with database.unit_of_work(write=True) as recovered:
            assert (
                await recovered.scalar(
                    text("SELECT count(*) FROM sqlite_master WHERE name='aborted'")
                )
                == 0
            )
    finally:
        await database.dispose()

"""Admission must be checked at submission, not only by an event-loop timer."""

import asyncio
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import cast

import aiosqlite
import pytest
from sqlalchemy import text
from test_auth_schema import migrate

from lexicona.database import Database


def consume_budget(deadline: float) -> None:
    """Model synchronous response/preparation work, not an async native wait."""
    time.sleep(max(0, deadline - time.monotonic()) + 0.01)


@pytest.mark.parametrize("phase", ["statement", "commit"])
async def test_expired_budget_never_submits_new_native_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    path = tmp_path / "submission.sqlite3"
    await asyncio.to_thread(migrate, path)
    database = Database(f"sqlite+aiosqlite:///{path}")
    original = cast(Callable[..., Awaitable[object]], aiosqlite.Connection._execute)
    submissions: list[str] = []
    expired = False

    async def execute(
        connection: aiosqlite.Connection,
        fn: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        if expired and (
            fn.__name__ == "commit" or args and str(args[0]).startswith("INSERT")
        ):
            submissions.append(fn.__name__ if not args else "INSERT")
        return await original(connection, fn, *args, **kwargs)

    try:
        async with database.unit_of_work(write=True) as session:
            await session.execute(
                text("CREATE TABLE native_budget_probe (value INTEGER)")
            )
        monkeypatch.setattr(aiosqlite.Connection, "_execute", execute)
        deadline = time.monotonic() + 0.1
        with pytest.raises(TimeoutError):
            async with database.unit_of_work(write=True, deadline=deadline) as session:
                if phase == "commit":
                    await session.execute(
                        text("INSERT INTO native_budget_probe VALUES (1)")
                    )
                # Deliberately consume the remaining budget synchronously. The
                # event-loop callback cannot run until the next native await;
                # the submission boundary must reject first, independently.
                consume_budget(deadline)
                expired = True
                if phase == "statement":
                    await session.execute(
                        text("INSERT INTO native_budget_probe VALUES (1)")
                    )
        expired = False
        async with database.unit_of_work() as session:
            rows = await session.scalar(
                text("SELECT count(*) FROM native_budget_probe")
            )
            assert await session.scalar(text("PRAGMA busy_timeout")) == 5000
        print({"phase": phase, "late_submissions": submissions, "rows": rows})
        assert submissions == [], "Expired admission submitted new business work"
        assert rows == 0
    finally:
        await database.dispose()


async def test_each_native_wait_uses_remaining_budget(tmp_path: Path) -> None:
    path = tmp_path / "remaining.sqlite3"
    await asyncio.to_thread(migrate, path)
    database = Database(f"sqlite+aiosqlite:///{path}")
    deadline = time.monotonic() + 0.4
    try:
        async with database.unit_of_work(write=True, deadline=deadline) as session:
            await asyncio.sleep(0.1)
            remaining_ms = int((deadline - time.monotonic()) * 1000)
            busy = await session.scalar(text("PRAGMA busy_timeout"))
            print({"remaining_ms": remaining_ms, "busy_ms": busy})
            assert isinstance(busy, int) and 0 < busy <= remaining_ms
        async with database.unit_of_work() as session:
            assert await session.scalar(text("PRAGMA busy_timeout")) == 5000
    finally:
        await database.dispose()


async def test_detached_native_connection_skips_reuse_reset(tmp_path: Path) -> None:
    path = tmp_path / "detached.sqlite3"
    await asyncio.to_thread(migrate, path)
    database = Database(f"sqlite+aiosqlite:///{path}")
    try:
        connection = await database.engine.connect()
        raw = await connection.run_sync(lambda db: db.connection.driver_connection)
        assert isinstance(raw, aiosqlite.Connection)
        await connection.exec_driver_sql("SELECT 1")
        await connection.run_sync(lambda db: db.detach())
        await connection.close()
        await asyncio.to_thread(raw._thread.join, 3)
        assert raw._connection is None and not raw._thread.is_alive()
        async with database.unit_of_work() as session:
            assert await session.scalar(text("PRAGMA busy_timeout")) == 5000
    finally:
        await database.dispose()


async def test_committed_http_response_cannot_outlive_admission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import UTC, datetime

    import httpx
    from asgi_lifespan import LifespanManager

    import lexicona.auth.boundary as boundary
    from lexicona.app import create_app
    from lexicona.auth.errors import Decision

    path = tmp_path / "response.sqlite3"
    await asyncio.to_thread(migrate, path)
    decisions: list[Decision] = []
    calls = 0

    def admit(deadline: float) -> Decision:
        context = Decision(time.monotonic() + 0.2)
        decisions.append(context)
        return context

    def clock() -> datetime:
        nonlocal calls
        calls += 1
        if calls == 3:
            # Both read and final write have finished, but response preparation
            # has consumed the rest of the SAME original request budget.
            consume_budget(decisions[0].deadline)
        return datetime(2026, 10, 21, tzinfo=UTC)

    monkeypatch.setattr(boundary, "Decision", admit)
    app = create_app(f"sqlite+aiosqlite:///{path}", clock=clock)
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://127.0.0.1:5173",
            headers={"Origin": "http://127.0.0.1:5173"},
        ) as client,
    ):
        response = await client.get("/api/v1/auth/csrf")
        print(
            {
                "response_status": response.status_code,
                "cookie": "set-cookie" in response.headers,
            }
        )
        assert response.status_code == 408, (
            "Expired committed response reported success"
        )
        assert response.json()["error"]["code"] == "request_timeout"
        assert "set-cookie" not in response.headers
    import sqlite3
    from contextlib import closing

    with closing(sqlite3.connect(path)) as observer:
        assert observer.execute("SELECT count(*) FROM auth_sessions").fetchone() == (1,)


async def test_http_pool_checkout_uses_original_admission_deadline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import httpx
    from asgi_lifespan import LifespanManager
    from sqlalchemy.pool import AsyncAdaptedQueuePool

    import lexicona.app as app_module
    import lexicona.auth.boundary as boundary
    from lexicona.auth.errors import Decision

    path = tmp_path / "pool.sqlite3"
    await asyncio.to_thread(migrate, path)
    database = Database(f"sqlite+aiosqlite:///{path}")
    monkeypatch.setattr(app_module, "Database", lambda url: database)
    deadlines: list[float] = []

    def admit(deadline: float) -> Decision:
        context = Decision(time.monotonic() + 0.1)
        deadlines.append(context.deadline)
        return context

    monkeypatch.setattr(boundary, "Decision", admit)
    app = app_module.create_app(f"sqlite+aiosqlite:///{path}")
    async with LifespanManager(app):
        connections = [await database.engine.connect() for _ in range(3)]
        pool = database.engine.sync_engine.pool
        assert isinstance(pool, AsyncAdaptedQueuePool)
        try:
            assert pool.checkedout() == 3
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://127.0.0.1:5173",
                headers={"Origin": "http://127.0.0.1:5173"},
            ) as client:
                response = await client.get("/api/v1/auth/csrf")
                assert response.status_code == 503
                assert response.json()["error"]["code"] == "db_busy"
                assert "set-cookie" not in response.headers
            assert time.monotonic() >= deadlines[0]
            assert pool.checkedout() == 3
        finally:
            for connection in connections:
                await connection.close()
        assert pool.checkedout() == 0
        async with database.unit_of_work() as session:
            assert await session.scalar(text("SELECT count(*) FROM auth_sessions")) == 0
            assert await session.scalar(text("PRAGMA busy_timeout")) == 5000

"""Native WAL barriers through actual HTTP auth, not cancelled SQL mocks."""

import asyncio
import threading
from collections.abc import Awaitable, Callable
from pathlib import Path
from time import monotonic
from typing import cast

import aiosqlite
import httpx
import pytest
from asgi_lifespan import LifespanManager
from sqlalchemy import text
from sqlalchemy.pool import AsyncAdaptedQueuePool
from starlette.types import Message, Receive, Scope, Send
from test_auth_schema import migrate

import lexicona.app as app_module
import lexicona.auth.boundary as boundary
from lexicona.auth.errors import AuthError, Decision
from lexicona.database import Database

ORIGIN = "http://127.0.0.1:5173"


@pytest.mark.parametrize("deadline_first", [False, True])
async def test_http_cancel_then_deadline_joins_native_insert(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, deadline_first: bool
) -> None:
    path = tmp_path / "native.sqlite3"
    await asyncio.to_thread(migrate, path)
    database = Database(f"sqlite+aiosqlite:///{path}")
    monkeypatch.setattr(app_module, "Database", lambda url: database)
    # Server-only test admission budget: no client-controlled deadline.
    monkeypatch.setattr(
        boundary, "Decision", lambda deadline: Decision(monotonic() + 0.2)
    )
    app = app_module.create_app(f"sqlite+aiosqlite:///{path}")
    loop = asyncio.get_running_loop()
    entered = asyncio.Event()
    close_submitted = asyncio.Event()
    release = threading.Event()
    original = cast(Callable[..., Awaitable[object]], aiosqlite.Connection._execute)
    connections: list[aiosqlite.Connection] = []
    submissions: list[str] = []
    messages: list[str] = []
    hit = False

    async def execute(
        connection: aiosqlite.Connection,
        fn: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        nonlocal hit
        if connection not in connections:
            connections.append(connection)
        sql = str(args[0]) if args else ""
        if hit and fn.__name__ == "close":
            close_submitted.set()
        if "INSERT INTO auth_sessions" in sql or fn.__name__ == "commit":
            submissions.append("insert" if sql else "commit")
        if not hit and "INSERT INTO auth_sessions" in sql:
            hit = True

            def work() -> object:
                loop.call_soon_threadsafe(entered.set)
                if not release.wait(8):
                    raise RuntimeError("native barrier timeout")
                return fn(*args, **kwargs)

            return await original(connection, work)
        return await original(connection, fn, *args, **kwargs)

    async def recorded(scope: Scope, receive: Receive, send: Send) -> None:
        async def capture(message: Message) -> None:
            messages.append(message["type"])
            await send(message)

        await app(scope, receive, capture)

    async with LifespanManager(app):
        monkeypatch.setattr(aiosqlite.Connection, "_execute", execute)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=recorded),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client:
            task = asyncio.create_task(client.get("/api/v1/auth/csrf"))
            try:
                await asyncio.wait_for(entered.wait(), 3)
                before = list(submissions)
                if deadline_first:
                    await asyncio.wait_for(close_submitted.wait(), 3)
                for _ in range(3):
                    task.cancel()
                    await asyncio.sleep(0)
                await asyncio.wait([task], timeout=0.4)
                premature = task.done()
                release.set()
                with pytest.raises(asyncio.CancelledError):
                    await task
                # Flush any driver termination left behind by the old bug before
                # asserting, so RED does not leak threads into the next test.
                for connection in connections:
                    if not connection._running:
                        await asyncio.to_thread(connection._thread.join, 3)
                print(
                    {
                        "deadline_first": deadline_first,
                        "premature_owner": premature,
                        "responses": messages,
                        "submissions_unchanged": submissions == before,
                        "native_closed": [c._connection is None for c in connections],
                    }
                )
                assert not premature, (
                    "HTTP owner returned before native INSERT finalized"
                )
                assert messages == []
                assert submissions == before
                pool = database.engine.sync_engine.pool
                assert isinstance(pool, AsyncAdaptedQueuePool)
                assert pool.checkedout() == 0
                async with database.unit_of_work() as db:
                    assert (
                        await db.scalar(text("SELECT count(*) FROM auth_sessions")) == 0
                    )
                    assert await db.scalar(text("PRAGMA busy_timeout")) == 5000
            finally:
                release.set()
                await asyncio.gather(task, return_exceptions=True)


class NativeBarrier:
    """Pause one actual worker callable, recording no SQL parameters/secrets."""

    def __init__(self, phase: str) -> None:
        self.phase = phase
        self.loop = asyncio.get_running_loop()
        self.entered = asyncio.Event()
        self.release = threading.Event()
        self.original = cast(
            Callable[..., Awaitable[object]], aiosqlite.Connection._execute
        )
        self.connections: list[aiosqlite.Connection] = []
        self.submissions: list[str] = []
        self.heads: list[asyncio.Future[object]] = []
        self.hit = False
        self.writing = False
        self.committed = False
        self.finished = False
        self.target: aiosqlite.Connection | None = None

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def execute(
            connection: aiosqlite.Connection,
            fn: Callable[..., object],
            *args: object,
            **kwargs: object,
        ) -> object:
            return await self.execute(connection, fn, *args, **kwargs)

        monkeypatch.setattr(aiosqlite.Connection, "_execute", execute)

    def pause(self) -> None:
        self.loop.call_soon_threadsafe(self.entered.set)
        if not self.release.wait(8):
            raise RuntimeError("native barrier timeout")

    async def execute(
        self,
        connection: aiosqlite.Connection,
        fn: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        if connection not in self.connections:
            self.connections.append(connection)
        sql = str(args[0]) if args else ""
        name = fn.__name__
        if sql == "BEGIN IMMEDIATE":
            self.writing = True
        if self.writing and (sql and not sql.startswith("PRAGMA") or name == "commit"):
            self.submissions.append(sql.split()[0] if sql else name)
        selected = not self.hit and (
            (
                self.phase == "prewrite"
                and not self.writing
                and "SELECT version_num" in sql
            )
            or (self.phase in {"queued_begin", "begin"} and sql == "BEGIN IMMEDIATE")
            or (self.phase == "delete" and "DELETE FROM auth_sessions" in sql)
            or (
                self.phase in {"insert", "queued_write"}
                and "INSERT INTO auth_sessions" in sql
            )
            or (
                self.phase in {"commit", "queued_commit", "after_commit", "lost_commit"}
                and self.writing
                and name == "commit"
            )
            or (
                self.phase == "reset"
                and self.committed
                and sql == "PRAGMA busy_timeout=5000"
            )
        )
        if selected:
            self.hit = True
            self.target = connection
            if self.phase.startswith("queued_"):
                head: asyncio.Future[object] = self.loop.create_future()
                self.heads.append(head)
                connection._tx.put_nowait((head, self.pause))

            def work() -> object:
                if not self.phase.startswith("queued_") and self.phase not in {
                    "after_commit",
                    "lost_commit",
                }:
                    self.pause()
                result = fn(*args, **kwargs)
                if name == "commit":
                    self.committed = True
                if self.phase == "after_commit":
                    self.pause()
                self.finished = True
                if self.phase == "lost_commit":
                    import sqlite3

                    raise sqlite3.OperationalError("test commit acknowledgement lost")
                return result

            return await self.original(connection, work)
        result = await self.original(connection, fn, *args, **kwargs)
        if self.writing and name == "commit":
            self.committed = True
        return result


@pytest.mark.parametrize(
    "phase",
    [
        "prewrite",
        "queued_begin",
        "begin",
        "delete",
        "queued_write",
        "insert",
        "queued_commit",
        "commit",
        "after_commit",
        "reset",
    ],
)
@pytest.mark.parametrize("cancel", [True, False], ids=["repeated-cancel", "deadline"])
async def test_http_native_finalization_matrix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str, cancel: bool
) -> None:
    path = tmp_path / "matrix.sqlite3"
    await asyncio.to_thread(migrate, path)
    database = Database(f"sqlite+aiosqlite:///{path}")
    monkeypatch.setattr(app_module, "Database", lambda url: database)
    # Always the same server admission timestamp, including DB checkout/commit.
    deadlines: list[float] = []

    def admit(deadline: float) -> Decision:
        context = Decision(monotonic() + 0.2)
        deadlines.append(context.deadline)
        return context

    monkeypatch.setattr(boundary, "Decision", admit)
    app = app_module.create_app(f"sqlite+aiosqlite:///{path}")
    barrier = NativeBarrier(phase)
    messages: list[str] = []

    async def recorded(scope: Scope, receive: Receive, send: Send) -> None:
        async def capture(message: Message) -> None:
            messages.append(message["type"])
            await send(message)

        await app(scope, receive, capture)

    async with LifespanManager(app):
        barrier.install(monkeypatch)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=recorded),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client:
            tasks_before = asyncio.all_tasks()
            task = asyncio.create_task(client.get("/api/v1/auth/csrf"))
            try:
                await asyncio.wait_for(barrier.entered.wait(), 3)
                before = list(barrier.submissions)
                if cancel:
                    for _ in range(3):
                        task.cancel()
                        await asyncio.sleep(0)
                start = monotonic()
                await asyncio.wait([task], timeout=0.35)
                premature = task.done()
                before_response = list(messages)
                assert not barrier.finished
                barrier.release.set()
                if cancel:
                    with pytest.raises(asyncio.CancelledError):
                        await task
                else:
                    response = await task
                    assert response.status_code in {408, 503}
                    assert "set-cookie" not in response.headers
                finalized_at = monotonic()
                assert finalized_at >= deadlines[0]
                assert not premature, "HTTP returned before native finalization"
                assert not before_response, (
                    "HTTP response escaped before native finalization"
                )
                assert barrier.finished
                assert barrier.submissions == before, (
                    "New business SQL submitted after cancel/expiry"
                )
                assert barrier.target is not None
                # A reset cancellation can safely survive; cancelled active
                # statements/commit invalidate and join native close.
                if barrier.target._connection is None:
                    await asyncio.to_thread(barrier.target._thread.join, 3)
                    assert not barrier.target._thread.is_alive()
                pool = database.engine.sync_engine.pool
                assert (
                    isinstance(pool, AsyncAdaptedQueuePool) and pool.checkedout() == 0
                )
                async with database.unit_of_work() as db:
                    assert await db.scalar(text("PRAGMA journal_mode")) == "wal"
                    assert await db.scalar(text("PRAGMA busy_timeout")) == 5000
                    expected = int(
                        phase in {"queued_commit", "commit", "after_commit", "reset"}
                    )
                    assert (
                        await db.scalar(text("SELECT count(*) FROM auth_sessions"))
                        == expected
                    )
                await asyncio.sleep(0)
                assert not (asyncio.all_tasks() - tasks_before)
                print(
                    {
                        "phase": phase,
                        "cancel": cancel,
                        "premature": premature,
                        "joined": barrier.finished,
                        "rows": expected,
                        "held_seconds": round(monotonic() - start, 3),
                        "finalization_overshoot_ms": round(
                            (finalized_at - deadlines[0]) * 1000, 1
                        ),
                    }
                )
            finally:
                barrier.release.set()
                await asyncio.gather(task, *barrier.heads, return_exceptions=True)


async def test_http_unknown_commit_invalidates_without_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "unknown.sqlite3"
    await asyncio.to_thread(migrate, path)
    database = Database(f"sqlite+aiosqlite:///{path}")
    monkeypatch.setattr(app_module, "Database", lambda url: database)
    app = app_module.create_app(f"sqlite+aiosqlite:///{path}")
    barrier = NativeBarrier("lost_commit")
    async with LifespanManager(app):
        barrier.install(monkeypatch)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client:
            response = await client.get("/api/v1/auth/csrf")
            assert response.status_code == 503
            assert response.json()["error"]["code"] == "service_unavailable"
            assert "set-cookie" not in response.headers
            assert barrier.submissions.count("INSERT") == 1
            assert barrier.submissions.count("commit") == 1
            assert barrier.target is not None
            print({"unknown_connection_closed": barrier.target._connection is None})
            assert barrier.target._connection is None, (
                "Unknown commit connection reused"
            )
            await asyncio.to_thread(barrier.target._thread.join, 3)
            assert not barrier.target._thread.is_alive()
            async with database.unit_of_work() as db:
                # Lost acknowledgement is NOT evidence of rollback.
                assert await db.scalar(text("SELECT count(*) FROM auth_sessions")) == 1
                assert await db.scalar(text("PRAGMA busy_timeout")) == 5000


@pytest.mark.parametrize(
    "error",
    [
        AuthError("service_unavailable"),
        TimeoutError(),
        OSError(),
        RuntimeError(),
    ],
)
async def test_transport_loss_after_committed_headers_does_not_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    path = tmp_path / "transport.sqlite3"
    await asyncio.to_thread(migrate, path)
    database = Database(f"sqlite+aiosqlite:///{path}")
    monkeypatch.setattr(app_module, "Database", lambda url: database)
    app = app_module.create_app(f"sqlite+aiosqlite:///{path}")
    messages: list[str] = []

    async def transport(scope: Scope, receive: Receive, send: Send) -> None:
        async def lost(message: Message) -> None:
            messages.append(message["type"])
            await send(message)
            if message["type"] == "http.response.start":
                raise error

        await app(scope, receive, lost)

    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=transport),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client,
    ):
        with pytest.raises(type(error)):
            await client.get("/api/v1/auth/csrf")
        assert messages == ["http.response.start"]
        async with database.unit_of_work() as db:
            assert await db.scalar(text("SELECT count(*) FROM auth_sessions")) == 1
            assert await db.scalar(text("PRAGMA busy_timeout")) == 5000


async def test_unexpected_native_write_failure_rolls_back_without_cookie(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "write-failure.sqlite3"
    await asyncio.to_thread(migrate, path)
    database = Database(f"sqlite+aiosqlite:///{path}")
    monkeypatch.setattr(app_module, "Database", lambda url: database)
    app = app_module.create_app(f"sqlite+aiosqlite:///{path}")
    original = cast(Callable[..., Awaitable[object]], aiosqlite.Connection._execute)
    writes = 0

    async def execute(
        connection: aiosqlite.Connection,
        fn: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        nonlocal writes
        result = await original(connection, fn, *args, **kwargs)
        if args and "INSERT INTO auth_sessions" in str(args[0]):
            writes += 1
            raise RuntimeError("test native result failure")
        return result

    async with LifespanManager(app):
        monkeypatch.setattr(aiosqlite.Connection, "_execute", execute)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client:
            response = await client.get("/api/v1/auth/csrf")
            assert response.status_code == 500
            assert response.json()["error"]["code"] == "internal_error"
            assert "set-cookie" not in response.headers and writes == 1
            async with database.unit_of_work() as db:
                assert await db.scalar(text("SELECT count(*) FROM auth_sessions")) == 0
                assert await db.scalar(text("PRAGMA busy_timeout")) == 5000


@pytest.mark.parametrize("phase", ["invalidate", "rollback"])
async def test_native_failure_cleanup_join_survives_outer_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    path = tmp_path / "unknown-cleanup.sqlite3"
    await asyncio.to_thread(migrate, path)
    database = Database(f"sqlite+aiosqlite:///{path}")
    monkeypatch.setattr(app_module, "Database", lambda url: database)
    app = app_module.create_app(f"sqlite+aiosqlite:///{path}")
    barrier = NativeBarrier("lost_commit" if phase == "invalidate" else "unused")
    entered = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()

    async def execute(
        connection: aiosqlite.Connection,
        fn: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        if barrier.hit and fn.__name__ == (
            "close" if phase == "invalidate" else "rollback"
        ):

            def close() -> object:
                loop.call_soon_threadsafe(entered.set)
                if not release.wait(8):
                    raise RuntimeError("native cleanup barrier timeout")
                return fn(*args, **kwargs)

            return await barrier.original(connection, close)
        if phase == "rollback" and args and "INSERT INTO auth_sessions" in str(args[0]):
            await barrier.original(connection, fn, *args, **kwargs)
            barrier.hit = True
            barrier.target = connection
            raise RuntimeError("test failure after native write")
        return await barrier.execute(connection, fn, *args, **kwargs)

    async with LifespanManager(app):
        monkeypatch.setattr(aiosqlite.Connection, "_execute", execute)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client:
            task = asyncio.create_task(client.get("/api/v1/auth/csrf"))
            try:
                await asyncio.wait_for(entered.wait(), 3)
                for _ in range(3):
                    task.cancel()
                    await asyncio.sleep(0)
                await asyncio.wait([task], timeout=0.15)
                premature = task.done()
                release.set()
                with pytest.raises(asyncio.CancelledError):
                    await task
                assert barrier.target is not None
                if phase == "invalidate":
                    await asyncio.to_thread(barrier.target._thread.join, 3)
                    assert not barrier.target._thread.is_alive()
                print({"phase": phase, "cleanup_premature_owner": premature})
                assert not premature, (
                    "Owner returned before unknown-commit native close"
                )
                async with database.unit_of_work() as db:
                    assert await db.scalar(
                        text("SELECT count(*) FROM auth_sessions")
                    ) == int(phase == "invalidate")
                    assert await db.scalar(text("PRAGMA busy_timeout")) == 5000
            finally:
                release.set()
                await asyncio.gather(task, return_exceptions=True)

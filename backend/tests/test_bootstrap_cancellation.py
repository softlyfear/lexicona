"""CLI ownership of native SQLite work survives repeated outer cancellation."""

import asyncio
import json
import secrets
import sqlite3
import threading
from collections.abc import Awaitable, Callable
from contextlib import closing
from pathlib import Path
from typing import cast

import aiosqlite
import pytest
from sqlalchemy.pool import AsyncAdaptedQueuePool
from test_admin_pty import counts
from test_auth_schema import migrate

import lexicona.operations.admin as admin
from lexicona.database import Database


@pytest.mark.parametrize("cancels", [1, 3])
@pytest.mark.parametrize(
    "phase", ["readiness", "check", "begin", "user", "settings", "commit"]
)
async def test_cli_native_work_join_survives_repeated_cancellation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    phase: str,
    cancels: int,
    request: pytest.FixtureRequest,
) -> None:
    path = tmp_path / "native-cancellation.sqlite3"
    await asyncio.to_thread(migrate, path)
    with closing(sqlite3.connect(path)) as observer:
        assert observer.execute("PRAGMA journal_mode").fetchone() == ("wal",)
    database = Database(f"sqlite+aiosqlite:///{path}")
    monkeypatch.setattr(admin, "Database", lambda url: database)
    loop = asyncio.get_running_loop()
    entered, close_submitted = asyncio.Event(), asyncio.Event()
    release = threading.Event()
    connections: list[aiosqlite.Connection] = []
    submissions: list[str] = []
    hit = False
    user_submitted = False
    original = cast(Callable[..., Awaitable[object]], aiosqlite.Connection._execute)

    async def execute(
        connection: aiosqlite.Connection,
        fn: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        nonlocal hit, user_submitted
        if connection not in connections:
            connections.append(connection)
        sql = str(args[0]) if args else ""
        if "INSERT INTO" in sql or (user_submitted and fn.__name__ == "commit"):
            submissions.append(sql or "commit")
        if "INSERT INTO users" in sql:
            user_submitted = True
        selected = not hit and (
            (phase == "readiness" and "SELECT version_num" in sql)
            or (phase == "check" and "SELECT 1 FROM users WHERE" in sql)
            or (phase == "begin" and sql == "BEGIN IMMEDIATE")
            or (phase == "user" and "INSERT INTO users" in sql)
            or (phase == "settings" and "INSERT INTO user_settings" in sql)
            or (phase == "commit" and user_submitted and fn.__name__ == "commit")
        )
        if selected:
            hit = True

            def native_work() -> object:
                loop.call_soon_threadsafe(entered.set)
                if not release.wait(8):
                    raise RuntimeError("native test barrier deadline")
                return fn(*args, **kwargs)

            return await original(connection, native_work)
        if hit and fn.__name__ == "close":
            loop.call_soon(close_submitted.set)
        return await original(connection, fn, *args, **kwargs)

    monkeypatch.setattr(aiosqlite.Connection, "_execute", execute)
    args = admin.Arguments(command="bootstrap", login="admin", display_name="Имя")
    task = asyncio.create_task(admin._run(args, secrets.token_urlsafe(24)))
    try:
        await asyncio.wait_for(entered.wait(), 3)
        submitted_at_cancel = list(submissions)
        task.cancel()
        await asyncio.wait_for(close_submitted.wait(), 3)
        for _ in range(cancels - 1):
            task.cancel()
            acknowledged = asyncio.Event()
            loop.call_soon(acknowledged.set)
            await acknowledged.wait()
        # The native barrier fixes the race outcome. This bounded observation only
        # gives already queued cancellation/finalization callbacks time to run.
        await asyncio.wait([task], timeout=0.15)
        completed_before_release = task.done()
        alive_before_release = [
            connection._thread.is_alive() for connection in connections
        ]
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        for connection in connections:
            await asyncio.to_thread(connection._thread.join, 3)
        persisted = await asyncio.to_thread(counts, path)
        request.node.user_properties.append(
            (
                "native_proof",
                json.dumps(
                    {
                        "phase": phase,
                        "cancels": cancels,
                        "journal_mode": "wal",
                        "completed_before_release": completed_before_release,
                        "alive_before_release": alive_before_release,
                        "alive_after_join": [
                            connection._thread.is_alive() for connection in connections
                        ],
                        "closed_after_join": [
                            connection._connection is None for connection in connections
                        ],
                        "submissions_before_cancel": submitted_at_cancel,
                        "submissions_after_join": submissions,
                        "persisted_rows": persisted,
                    }
                ),
            )
        )
        assert not completed_before_release, "CLI returned before active DB termination"
        assert alive_before_release and all(alive_before_release)
        assert all(not connection._thread.is_alive() for connection in connections)
        assert all(connection._connection is None for connection in connections)
        assert submissions == submitted_at_cancel, (
            "Cancellation allowed new business SQL"
        )
        pool = database.engine.sync_engine.pool
        assert isinstance(pool, AsyncAdaptedQueuePool)
        assert pool.checkedout() == 0
        # Only a known submitted COMMIT has persisted both rows. No unknown-outcome
        # rollback claim; lost-acknowledgement semantics have a separate regression.
        expected = int(phase == "commit")
        assert persisted == (expected, expected)
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
        await database.dispose()
        for connection in connections:
            await asyncio.to_thread(connection._thread.join, 3)

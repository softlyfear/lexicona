"""First-admin failure atomicity and explicit unknown-outcome handling."""

import asyncio
import getpass
import logging
import runpy
import secrets
import sqlite3
import sys
import threading
from collections.abc import Awaitable, Callable
from contextlib import closing
from pathlib import Path
from time import monotonic
from typing import cast

import aiosqlite
import pytest
from sqlalchemy import text
from test_admin_pty import counts
from test_auth_schema import migrate
from test_bootstrap import auth_database as auth_database
from test_passwords import BarrierHasher, until

from lexicona.auth.bootstrap import BootstrapError, BootstrapService
from lexicona.auth.passwords import Hasher, PasswordService
from lexicona.database import Database
from lexicona.operations.admin import main


async def test_schema_rechecked_after_hash(auth_database: Database) -> None:
    class Changed(PasswordService):
        async def hash(self, password: str, *, deadline: float) -> str:
            async with auth_database.unit_of_work(write=True) as session:
                await session.execute(
                    text("UPDATE alembic_version SET version_num='old'")
                )
            return "PHC"

    passwords = Changed()
    try:
        with pytest.raises(BootstrapError) as error:
            await BootstrapService(auth_database, passwords).create(
                "admin", "Имя", secrets.token_urlsafe(24), deadline=monotonic() + 12
            )
        assert error.value.exit_code == 5
    finally:
        await passwords.aclose()


async def test_hash_does_not_hold_writer_and_cancel_before_write_has_no_rows(
    auth_database: Database,
) -> None:
    hasher = BarrierHasher()
    passwords = PasswordService(Hasher(hasher.hash, hasher.verify))
    task = asyncio.create_task(
        BootstrapService(auth_database, passwords).create(
            "admin", "Имя", "0" * 12, deadline=monotonic() + 12
        )
    )
    # This DI hasher uses a fixed synthetic label, not the production cheap profile.
    hasher.gates["0" * 12] = threading.Event()
    try:
        await until(lambda: bool(hasher.started))
        async with auth_database.unit_of_work(write=True) as writer:
            assert await writer.scalar(text("SELECT count(*) FROM users")) == 0
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert passwords.running == 1
        hasher.gates["0" * 12].set()
        await until(lambda: passwords.running == 0)
        async with auth_database.unit_of_work() as session:
            assert await session.scalar(text("SELECT count(*) FROM users")) == 0
    finally:
        hasher.gates["0" * 12].set()
        await passwords.aclose()


@pytest.mark.parametrize(
    "exception", [ValueError, getpass.GetPassWarning, EOFError, KeyboardInterrupt]
)
def test_cli_static_prompt_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    exception: type[BaseException],
) -> None:
    path = tmp_path / "prompt.sqlite3"
    migrate(path)
    monkeypatch.setenv("LEXICONA_DATABASE_URL", f"sqlite+aiosqlite:///{path}")
    secret = secrets.token_urlsafe(24)

    def prompt() -> str:
        raise exception(secret)

    result = main(
        ["bootstrap", "--login", "admin", "--display-name", "Имя"], prompt=prompt
    )
    assert result == (130 if exception in {EOFError, KeyboardInterrupt} else 2)
    output = capsys.readouterr()
    assert secret not in output.out + output.err
    assert counts(path) == (0, 0)


def test_cli_entrypoint_never_echoes_unknown_secret(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    secret = secrets.token_urlsafe(24)
    monkeypatch.setattr(sys, "argv", ["admin", "bootstrap", "--password", secret])
    monkeypatch.delitem(sys.modules, "lexicona.operations.admin", raising=False)
    with pytest.raises(SystemExit) as error:
        runpy.run_module(
            "lexicona.operations.admin", run_name="__main__", alter_sys=True
        )
    assert error.value.code == 2
    output = capsys.readouterr()
    assert secret not in output.out + output.err


def test_cli_settings_failure_is_atomic_and_logs_are_redacted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    path = tmp_path / "rollback.sqlite3"
    migrate(path)
    with closing(sqlite3.connect(path)) as connection:
        connection.execute(
            "CREATE TRIGGER abort_settings BEFORE INSERT ON user_settings "
            "BEGIN SELECT RAISE(ABORT,'fixture'); END"
        )
        connection.commit()
    monkeypatch.setenv("LEXICONA_DATABASE_URL", f"sqlite+aiosqlite:///{path}")
    secret = secrets.token_urlsafe(24)
    with caplog.at_level(logging.DEBUG):
        assert (
            main(
                ["bootstrap", "--login", "admin", "--display-name", "Имя"],
                prompt=lambda: secret,
            )
            == 5
        )
    output = capsys.readouterr()
    assert output.out == "" and output.err.strip() == "База данных не готова."
    assert secret not in output.out + output.err + caplog.text
    assert "$argon2" not in caplog.text
    assert counts(path) == (0, 0)


def test_cli_busy_is_bounded_no_retry_or_partial_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "busy-cli.sqlite3"
    migrate(path)
    monkeypatch.setenv("LEXICONA_DATABASE_URL", f"sqlite+aiosqlite:///{path}")
    secret = secrets.token_urlsafe(24)
    with closing(sqlite3.connect(path, isolation_level=None)) as lock:
        lock.execute("BEGIN IMMEDIATE")
        start = monotonic()
        assert (
            main(
                ["bootstrap", "--login", "admin", "--display-name", "Имя"],
                prompt=lambda: secret,
            )
            == 5
        )
        assert 4.5 <= monotonic() - start < 8
        lock.rollback()
    output = capsys.readouterr()
    assert output.err.strip() == "База данных не готова."
    assert counts(path) == (0, 0)


def test_cli_unknown_commit_is_not_claimed_as_rollback_or_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "unknown.sqlite3"
    migrate(path)
    monkeypatch.setenv("LEXICONA_DATABASE_URL", f"sqlite+aiosqlite:///{path}")
    original = cast(Callable[..., Awaitable[object]], aiosqlite.Connection._execute)
    pending = False
    commits = 0

    async def execute(
        connection: aiosqlite.Connection,
        fn: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        nonlocal pending, commits
        if args and "INSERT INTO users" in str(args[0]):
            pending = True
        if pending and fn.__name__ == "commit":
            pending = False
            commits += 1

            def unknown() -> object:
                fn(*args, **kwargs)
                raise sqlite3.OperationalError("fixture lost commit acknowledgement")

            return await original(connection, unknown)
        return await original(connection, fn, *args, **kwargs)

    monkeypatch.setattr(aiosqlite.Connection, "_execute", execute)
    assert (
        main(
            ["bootstrap", "--login", "admin", "--display-name", "Имя"],
            prompt=lambda: secrets.token_urlsafe(24),
        )
        == 5
    )
    output = capsys.readouterr()
    assert output.out == "" and output.err.strip() == "База данных не готова."
    assert commits == 1 and counts(path) == (1, 1)


@pytest.mark.parametrize("phase", ["hash_join", "database_dispose"])
async def test_cli_repeated_cancellation_joins_hash_and_disposes_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    import lexicona.operations.admin as module

    path = tmp_path / "cancel-resources.sqlite3"
    await asyncio.to_thread(migrate, path)
    monkeypatch.setenv("LEXICONA_DATABASE_URL", f"sqlite+aiosqlite:///{path}")
    loop = asyncio.get_running_loop()
    hash_started, joining, disposing = (asyncio.Event() for _ in range(3))
    hash_release = threading.Event()
    dispose_release = asyncio.Event()
    disposed = False
    databases: list[Database] = []
    services: list[PasswordService] = []

    class TrackedDatabase(Database):
        def __init__(self, url: str) -> None:
            super().__init__(url)
            databases.append(self)

        async def dispose(self) -> None:
            nonlocal disposed
            disposing.set()
            if phase == "database_dispose":
                await dispose_release.wait()
            await super().dispose()
            disposed = True

    def hash_work(secret: str) -> str:
        loop.call_soon_threadsafe(hash_started.set)
        assert hash_release.wait(5)
        return "PHC"

    class TrackedPasswords(PasswordService):
        def __init__(self) -> None:
            super().__init__(Hasher(hash_work, lambda encoded, secret: False))
            services.append(self)

        async def aclose(self) -> None:
            joining.set()
            await super().aclose()

    monkeypatch.setattr(module, "Database", TrackedDatabase)
    monkeypatch.setattr(module, "PasswordService", TrackedPasswords)
    args = module.Arguments(command="bootstrap", login="admin", display_name="Имя")
    task = asyncio.create_task(module._run(args, secrets.token_urlsafe(24)))
    try:
        await asyncio.wait_for(hash_started.wait(), 3)
        task.cancel()
        await asyncio.wait_for(joining.wait(), 3)
        if phase == "database_dispose":
            hash_release.set()
            await asyncio.wait_for(disposing.wait(), 3)
        for _ in range(2):
            task.cancel()
            acknowledged = asyncio.Event()
            loop.call_soon(acknowledged.set)
            await acknowledged.wait()
        hash_release.set()
        dispose_release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert disposed, "CLI cancellation skipped database disposal"
        assert services[0].running == 0
        pool = databases[0].engine.sync_engine.pool
        from sqlalchemy.pool import AsyncAdaptedQueuePool

        assert isinstance(pool, AsyncAdaptedQueuePool)
        assert pool.checkedout() == 0
        assert await asyncio.to_thread(counts, path) == (0, 0)
    finally:
        hash_release.set()
        dispose_release.set()
        await services[0].aclose()
        await databases[0].dispose()

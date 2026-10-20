"""First administrator: explicit commit, atomic settings and safe CLI errors."""

import asyncio
import secrets
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic

import pytest
from sqlalchemy import text
from test_auth_schema import migrate

from lexicona.database import Database


@pytest.fixture
async def auth_database(tmp_path: Path) -> AsyncIterator[Database]:
    path = tmp_path / "bootstrap.sqlite3"
    await asyncio.to_thread(migrate, path)
    db = Database(f"sqlite+aiosqlite:///{path}")
    try:
        yield db
    finally:
        await db.dispose()


async def test_bootstrap_creates_one_admin_settings_and_prioritizes_duplicate(
    auth_database: Database,
) -> None:
    from lexicona.auth.bootstrap import BootstrapError, BootstrapService
    from lexicona.auth.passwords import PasswordService

    service = PasswordService()
    bootstrap = BootstrapService(
        auth_database, service, clock=lambda: datetime(2026, 1, 1, tzinfo=UTC)
    )
    try:
        await bootstrap.create(
            "ADMIN",
            " E\u0301 ",
            "  😀" + secrets.token_urlsafe(24) + " ",
            deadline=monotonic() + 12,
        )
        async with auth_database.unit_of_work() as s:
            row = (
                await s.execute(
                    text(
                        "SELECT login,display_name,role,is_active,version,"
                        "created_at,updated_at FROM users"
                    )
                )
            ).one()
            assert tuple(row) == (
                "admin",
                "É",
                "admin",
                1,
                1,
                1767225600000000,
                1767225600000000,
            )
            assert (
                await s.execute(
                    text(
                        "SELECT timezone,theme,daily_goal,speech_rate,"
                        "english_locale,version FROM user_settings"
                    )
                )
            ).one() == ("UTC", "dark", 10, 1.0, "en-US", 1)
        for login, expected in [("Admin", 3), ("other", 4)]:
            with pytest.raises(BootstrapError) as error:
                await bootstrap.create(
                    login, "Имя", secrets.token_urlsafe(24), deadline=monotonic() + 12
                )
            assert error.value.exit_code == expected
    finally:
        await service.aclose()


def test_cli_validation_is_static_before_prompt(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from lexicona.operations.admin import main

    def forbidden() -> str:
        pytest.fail("Invalid arguments must not prompt")

    secret = secrets.token_urlsafe(24)
    assert (
        main(["bootstrap", "--login", "a", "--display-name", "Имя"], prompt=forbidden)
        == 2
    )
    assert (
        main(
            [
                "bootstrap",
                "--login",
                "admin",
                "--display-name",
                "Имя",
                "--password",
                secret,
            ],
            prompt=forbidden,
        )
        == 2
    )
    captured = capsys.readouterr()
    assert secret not in captured.out + captured.err
    assert "Traceback" not in captured.out + captured.err


def test_cli_known_commit_and_wrong_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from lexicona.operations.admin import main

    path = tmp_path / "cli.sqlite3"
    monkeypatch.setenv("LEXICONA_DATABASE_URL", f"sqlite+aiosqlite:///{path}")
    secret = secrets.token_urlsafe(24)
    args = ["bootstrap", "--login", "admin", "--display-name", "Имя"]
    assert main(args, prompt=lambda: secret) == 5
    assert capsys.readouterr().err.strip() == "База данных не готова."
    migrate(path)
    assert main(args, prompt=lambda: secret) == 0
    assert capsys.readouterr().out.strip() == "Первый администратор создан."
    assert main(args, prompt=lambda: secret) == 3
    assert capsys.readouterr().err.strip() == "Логин недоступен."


def test_protected_prompt_no_fallback_and_exact_confirmation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import getpass
    import sys
    import warnings

    from lexicona.operations.admin import protected_password

    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    with pytest.raises(ValueError):
        protected_password()
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    secret = " " + secrets.token_urlsafe(24) + " "
    values = iter([secret, secret])
    monkeypatch.setattr(getpass, "getpass", lambda prompt: next(values))
    assert protected_password() == secret
    values = iter([secret, secret.strip()])
    with pytest.raises(ValueError):
        protected_password()

    def warning(prompt: str) -> str:
        warnings.warn("unsafe fallback", getpass.GetPassWarning, stacklevel=2)
        pytest.fail("Must not fall back")

    monkeypatch.setattr(getpass, "getpass", warning)
    with pytest.raises(getpass.GetPassWarning):
        protected_password()


async def test_expired_prepared_hash_does_not_submit_write(
    auth_database: Database,
) -> None:
    from lexicona.auth.bootstrap import BootstrapError, BootstrapService
    from lexicona.auth.passwords import PasswordService

    class Prepared(PasswordService):
        async def hash(self, password: str, *, deadline: float) -> str:
            return "PHC"

    passwords = Prepared()
    try:
        with pytest.raises(BootstrapError) as error:
            await BootstrapService(auth_database, passwords).create(
                "admin", "Имя", secrets.token_urlsafe(24), deadline=monotonic() - 1
            )
        assert error.value.exit_code == 5
        async with auth_database.unit_of_work() as session:
            assert await session.scalar(text("SELECT count(*) FROM users")) == 0
    finally:
        await passwords.aclose()


def test_cli_runtime_invalid_database_url_is_exit5(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from lexicona.operations.admin import main

    monkeypatch.setenv("LEXICONA_DATABASE_URL", "sqlite:///:memory:")
    assert main(["bootstrap", "--login", "admin", "--display-name", "Имя"]) == 5
    assert capsys.readouterr().err.strip() == "База данных не готова."


@pytest.mark.parametrize("expiry", [False, True])
@pytest.mark.parametrize("phase", ["begin", "user", "settings", "commit"])
async def test_cancel_submitted_database_work_is_joined_before_pool_reuse(
    auth_database: Database, monkeypatch: pytest.MonkeyPatch, phase: str, expiry: bool
) -> None:
    import threading
    from collections.abc import Callable

    import aiosqlite
    from test_passwords import until

    import lexicona.auth.bootstrap as module
    from lexicona.auth.bootstrap import BootstrapService
    from lexicona.auth.passwords import PasswordService

    now = [1.0]
    monkeypatch.setattr(module, "monotonic", lambda: now[0])
    started, release = threading.Event(), threading.Event()
    enabled = False

    class Prepared(PasswordService):
        async def hash(self, password: str, *, deadline: float) -> str:
            nonlocal enabled
            enabled = True
            return "PHC"

    from collections.abc import Awaitable
    from typing import cast

    original = cast(Callable[..., Awaitable[object]], aiosqlite.Connection._execute)

    async def execute(
        connection: aiosqlite.Connection,
        fn: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        nonlocal enabled
        sql = str(args[0]) if args else ""
        hit = enabled and (
            (phase == "commit" and fn.__name__ == "commit")
            or (phase == "begin" and sql == "BEGIN IMMEDIATE")
            or (phase == "user" and "INSERT INTO users" in sql)
            or (phase == "settings" and "INSERT INTO user_settings" in sql)
        )
        if not hit:
            return await original(connection, fn, *args, **kwargs)
        enabled = False

        def gated() -> object:
            started.set()
            if not release.wait(5):
                raise RuntimeError("test gate deadline")
            return fn(*args, **kwargs)

        return await original(connection, gated)

    monkeypatch.setattr(aiosqlite.Connection, "_execute", execute)
    passwords = Prepared()
    task = asyncio.create_task(
        BootstrapService(auth_database, passwords).create(
            "admin", "Имя", secrets.token_urlsafe(24), deadline=100
        )
    )
    try:
        await until(started.is_set)
        if expiry:
            now[0] = 101
        else:
            task.cancel()
        await asyncio.sleep(0.02)
        completed_before_join = task.done()
        release.set()
        with pytest.raises(module.BootstrapError if expiry else asyncio.CancelledError):
            await task
        assert not completed_before_join, (
            "Cancellation returned before submitted driver work completed"
        )
        async with auth_database.unit_of_work() as session:
            expected = int(phase == "commit")
            assert await session.scalar(text("SELECT count(*) FROM users")) == expected
            assert (
                await session.scalar(text("SELECT count(*) FROM user_settings"))
                == expected
            )
            assert await session.scalar(text("PRAGMA integrity_check")) == "ok"
            assert (await session.execute(text("PRAGMA foreign_key_check"))).all() == []
    finally:
        release.set()
        await passwords.aclose()

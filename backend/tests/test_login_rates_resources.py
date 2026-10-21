"""Rate/credential guards and native ownership on actual HTTP and file SQLite."""

import asyncio
import secrets
import sqlite3
from collections.abc import AsyncIterator
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from time import monotonic

import httpx
import pytest
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from login_rate_helpers import LoginHasher, RateClock
from test_auth_schema import migrate
from test_login_rates_http import LOGIN, ORIGIN, pre_auth

from lexicona.app import create_app
from lexicona.auth import boundary
from lexicona.auth.errors import Decision
from lexicona.operations.admin import main

WRONG_PRINCIPAL = "user:00000000-0000-0000-0000-000000000001"


@dataclass(repr=False)
class Harness:
    path: Path
    app: FastAPI
    hasher: LoginHasher
    clock: RateClock
    password: str

    def client(self, address: str = "192.0.2.1") -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app, client=(address, 12345)),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        )


@pytest.fixture
async def harness(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> AsyncIterator[Harness]:
    path = tmp_path / "rates.sqlite3"
    await asyncio.to_thread(migrate, path)
    url = f"sqlite+aiosqlite:///{path}"
    monkeypatch.setenv("LEXICONA_DATABASE_URL", url)
    password = secrets.token_urlsafe(24)
    assert (
        await asyncio.to_thread(
            main,
            ["bootstrap", "--login", "admin", "--display-name", "Synthetic"],
            prompt=lambda: password,
        )
        == 0
    )
    assert capsys.readouterr().out == "Первый администратор создан.\n"
    hasher = LoginHasher()
    clock = RateClock()
    app = create_app(url, password_hasher=hasher.typed(), rate_clock=clock)
    async with LifespanManager(app):
        try:
            yield Harness(path, app, hasher, clock, password)
        finally:
            hasher.release.set()
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone() == ("wal",)


@pytest.mark.parametrize("account_axis", [True, False])
async def test_axes_independent_at_http_boundary(
    harness: Harness, account_axis: bool
) -> None:
    for n in range(6):
        async with harness.client(
            f"192.0.2.{n + 1}" if account_axis else "192.0.2.1"
        ) as client:
            headers = await pre_auth(client)
            response = await client.post(
                LOGIN,
                headers=headers,
                json={
                    "login": "ADMIN" if account_axis else f"missing_{n}",
                    "password": "synthetic-wrong",
                },
            )
            assert response.status_code == (401 if n < 5 else 429)
    assert harness.hasher.calls == 5


async def test_success_releases_only_own_slot_and_preserves_four_failures(
    harness: Harness,
) -> None:
    async with harness.client() as client:
        headers = await pre_auth(client)
        for _ in range(4):
            assert (
                await client.post(
                    LOGIN,
                    headers=headers,
                    json={"login": "ADMIN", "password": "synthetic-wrong"},
                )
            ).status_code == 401
        success = await client.post(
            LOGIN,
            headers=headers,
            json={"login": "admin", "password": harness.password},
        )
        assert success.status_code == 200
        assert (await client.get("/api/v1/auth/me")).status_code == 200
        client.cookies.clear()
        headers = await pre_auth(client)
        assert (
            await client.post(
                LOGIN,
                headers=headers,
                json={"login": "admin", "password": "synthetic-wrong"},
            )
        ).status_code == 401
        blocked = await client.post(
            LOGIN,
            headers=headers,
            json={"login": "admin", "password": harness.password},
        )
        assert blocked.status_code == 429 and harness.hasher.calls == 6
        harness.clock.value = 899.5
        assert (
            await client.post(
                LOGIN,
                headers=headers,
                json={"login": "admin", "password": harness.password},
            )
        ).headers["retry-after"] == "1"
        harness.clock.value = 900
        assert (
            await client.post(
                LOGIN,
                headers=headers,
                json={"login": "admin", "password": harness.password},
            )
        ).status_code == 200


@pytest.mark.parametrize("kind", ["unknown", "wrong", "inactive", "corrupt", "profile"])
async def test_generic_failures_and_real_or_dummy_work(
    harness: Harness, kind: str
) -> None:
    if kind in {"inactive", "corrupt", "profile"}:
        with closing(sqlite3.connect(harness.path)) as connection:
            if kind == "inactive":
                connection.execute("UPDATE users SET is_active=0,version=version+1")
            elif kind == "corrupt":
                connection.execute(
                    "UPDATE users SET password_hash='corrupt',version=version+1"
                )
            else:
                connection.execute(
                    "UPDATE users SET password_hash="
                    "replace(password_hash,'m=65536','m=65536000'),version=version+1"
                )
            connection.commit()
    async with harness.client() as client:
        headers = await pre_auth(client)
        for n in range(6):
            response = await client.post(
                LOGIN,
                headers=headers,
                json={
                    "login": "missing" if kind == "unknown" else "admin",
                    "password": "synthetic-wrong"
                    if kind == "wrong"
                    else harness.password,
                },
            )
            assert response.status_code == (401 if n < 5 else 429)
            assert response.json()["error"]["code"] == (
                "invalid_credentials" if n < 5 else "rate_limited"
            )
            assert "set-cookie" not in response.headers
        assert harness.hasher.calls == 5
    with closing(sqlite3.connect(harness.path)) as connection:
        assert connection.execute(
            "SELECT count(*) FROM auth_sessions WHERE user_id IS NOT NULL"
        ).fetchone() == (0,)


async def test_invalid_guards_and_body_do_not_consume_login_slots(
    harness: Harness,
) -> None:
    async with harness.client() as client:
        headers = await pre_auth(client)
        payload = {"login": "admin", "password": harness.password}
        for changes, status in [
            ({"Origin": "https://evil.invalid"}, 403),
            ({"X-CSRF-Token": "wrong"}, 403),
            (
                {"X-Lexicona-Expected-Principal": WRONG_PRINCIPAL},
                412,
            ),
        ]:
            assert (
                await client.post(LOGIN, headers=headers | changes, json=payload)
            ).status_code == status
        for data in [
            {},
            {"login": "x", "password": "short"},
            payload | {"role": "admin"},
            {"login": 42, "password": harness.password},
        ]:
            assert (
                await client.post(LOGIN, headers=headers, json=data)
            ).status_code == 422
        assert harness.hasher.calls == 0
        for _ in range(5):
            assert (
                await client.post(
                    LOGIN,
                    headers=headers,
                    json={"login": "admin", "password": "synthetic-wrong"},
                )
            ).status_code == 401
        assert harness.hasher.calls == 5


@pytest.mark.parametrize("cancel", [True, False])
async def test_http_running_job_holds_slot_across_expiry(
    harness: Harness,
    monkeypatch: pytest.MonkeyPatch,
    cancel: bool,
) -> None:
    async with harness.client() as client:
        headers = await pre_auth(client)
        # Shorten only this server admission; rate clock remains independent.
        budget = [12.0]
        monkeypatch.setattr(
            boundary, "Decision", lambda deadline: Decision(monotonic() + budget[0])
        )
        for _ in range(4):
            assert (
                await client.post(
                    LOGIN,
                    headers=headers,
                    json={"login": "admin", "password": "synthetic-wrong"},
                )
            ).status_code == 401
        budget[0] = 12 if cancel else 0.15
        harness.hasher.hold = True
        task = asyncio.create_task(
            client.post(
                LOGIN,
                headers=headers,
                json={"login": "admin", "password": harness.password},
            )
        )
        try:
            await harness.hasher.wait_started()
            if cancel:
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            else:
                response = await task
                assert (
                    response.status_code == 503
                    and response.json()["error"]["code"] == "auth_busy"
                )
            assert harness.hasher.calls == 5
            # Move beyond the old fixed window while the real worker is held.
            harness.clock.value = 900
            harness.hasher.hold = False
            budget[0] = 12
            for _ in range(4):
                assert (
                    await client.post(
                        LOGIN,
                        headers=headers,
                        json={"login": "admin", "password": "synthetic-wrong"},
                    )
                ).status_code == 401
            blocked = await client.post(
                LOGIN,
                headers=headers,
                json={"login": "admin", "password": harness.password},
            )
            assert blocked.status_code == 429 and harness.hasher.calls == 9
            with closing(sqlite3.connect(harness.path)) as connection:
                assert connection.execute(
                    "SELECT count(*) FROM auth_sessions WHERE user_id IS NOT NULL"
                ).fetchone() == (0,)
            # The detached native success is not an HTTP/DB login success.
            harness.hasher.release.set()
            await asyncio.sleep(0.15)
            assert (
                await client.post(
                    LOGIN,
                    headers=headers,
                    json={"login": "admin", "password": harness.password},
                )
            ).status_code == 429
        finally:
            harness.hasher.release.set()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("outcome", ["db-failure", "expiry"])
async def test_valid_password_without_final_success_is_not_refunded(
    harness: Harness,
    monkeypatch: pytest.MonkeyPatch,
    outcome: str,
) -> None:
    budget = [12.0]
    monkeypatch.setattr(
        boundary, "Decision", lambda deadline: Decision(monotonic() + budget[0])
    )
    async with harness.client() as client:
        headers = await pre_auth(client)
        for _ in range(4):
            assert (
                await client.post(
                    LOGIN,
                    headers=headers,
                    json={"login": "admin", "password": "synthetic-wrong"},
                )
            ).status_code == 401
        if outcome == "db-failure":

            def fail_write() -> None:
                with closing(sqlite3.connect(harness.path)) as connection:
                    connection.execute(
                        "CREATE TRIGGER fail_login BEFORE INSERT ON auth_sessions "
                        "BEGIN SELECT RAISE(ABORT,'synthetic'); END"
                    )
                    connection.commit()

            harness.hasher.action = fail_write
        else:
            budget[0] = 0.1
            harness.hasher.action = lambda: __import__("time").sleep(0.15)
        response = await client.post(
            LOGIN,
            headers=headers,
            json={"login": "admin", "password": harness.password},
        )
        assert response.status_code in {408, 503}
        assert "set-cookie" not in response.headers
        budget[0] = 12
        assert (
            await client.post(
                LOGIN,
                headers=headers,
                json={"login": "admin", "password": harness.password},
            )
        ).status_code == 429
        assert harness.hasher.calls == 5

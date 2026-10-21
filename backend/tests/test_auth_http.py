"""Actual HTTP/cookie tracer bullets on a migrated file-backed database."""

import asyncio
import base64
import hashlib
import sqlite3
from collections.abc import AsyncIterator
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import httpx
import pytest
from asgi_lifespan import LifespanManager
from test_auth_schema import migrate

from lexicona.app import create_app


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Origin": "null"},
        {"Origin": "http://127.0.0.1:5173.evil"},
        {"Sec-Fetch-Site": "cross-site"},
    ],
)
async def test_csrf_issuance_rejects_unconfirmed_browser_origin(
    tmp_path: Path, headers: dict[str, str]
) -> None:
    path = tmp_path / "origin.sqlite3"
    await asyncio.to_thread(migrate, path)
    app = create_app(f"sqlite+aiosqlite:///{path}")
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=ORIGIN
        ) as client,
    ):
        response = await client.get("/api/v1/auth/csrf", headers=headers)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "csrf_failed"
        assert response.headers[STAMP] == "anonymous"
        assert response.headers["cache-control"] == "no-store"
        assert "set-cookie" not in response.headers
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("SELECT count(*) FROM auth_sessions").fetchone() == (
            0,
        )


async def test_pre_auth_and_general_limits_are_independent(tmp_path: Path) -> None:
    path = tmp_path / "rate.sqlite3"
    await asyncio.to_thread(migrate, path)
    app = create_app(f"sqlite+aiosqlite:///{path}")
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client,
    ):
        for _ in range(20):
            client.cookies.clear()
            assert (await client.get("/api/v1/auth/csrf")).status_code == 200
        client.cookies.clear()
        blocked = await client.get("/api/v1/auth/csrf")
        assert blocked.status_code == 429
        assert 1 <= int(blocked.headers["retry-after"]) <= 60
        for _ in range(99):
            await client.get("/api/v1/auth/not-implemented")
        blocked = await client.get("/api/v1/auth/not-implemented")
        assert blocked.status_code == 429 and blocked.headers[STAMP] == "anonymous"
        assert (await client.get("/api/v1/health/live")).status_code == 200


async def test_pre_auth_global_cap_and_bounded_cleanup(tmp_path: Path) -> None:
    from datetime import UTC, datetime
    from uuid import uuid4

    path = tmp_path / "cap.sqlite3"
    await asyncio.to_thread(migrate, path)
    with closing(sqlite3.connect(path)) as connection:
        connection.executemany(
            "INSERT INTO auth_sessions VALUES (?,?,?, ?,?,?,?, ?,?)",
            [
                (
                    str(uuid4()),
                    None,
                    i.to_bytes(32, "big"),
                    "A" * 43,
                    1,
                    1,
                    1800000001,
                    1800000001,
                    None,
                )
                for i in range(10000)
            ],
        )
        connection.commit()
    now = [datetime(1970, 1, 1, tzinfo=UTC)]
    now[0] = now[0].replace(microsecond=2)
    app = create_app(f"sqlite+aiosqlite:///{path}", clock=lambda: now[0])
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client,
    ):
        response = await client.get("/api/v1/auth/csrf")
        assert response.status_code == 429 and "set-cookie" not in response.headers
        now[0] = datetime(1970, 1, 1, 0, 30, 0, 2, tzinfo=UTC)
        response = await client.get("/api/v1/auth/csrf")
        assert response.status_code == 200
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("SELECT count(*) FROM auth_sessions").fetchone() == (
            9501,
        )


async def test_cli_admin_can_login_with_atomic_rotation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import secrets

    from lexicona.operations.admin import main

    path = tmp_path / "login.sqlite3"
    await asyncio.to_thread(migrate, path)
    url = f"sqlite+aiosqlite:///{path}"
    monkeypatch.setenv("LEXICONA_DATABASE_URL", url)
    secret = secrets.token_urlsafe(24)
    assert (
        await asyncio.to_thread(
            main,
            ["bootstrap", "--login", "admin", "--display-name", "Имя"],
            prompt=lambda: secret,
        )
        == 0
    )
    assert secret not in capsys.readouterr().out
    app = create_app(url)
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client,
    ):
        pre = await client.get("/api/v1/auth/csrf")
        old_cookie = client.cookies[COOKIE]
        response = await client.post(
            "/api/v1/auth/login",
            json={"login": "ADMIN", "password": secret},
            headers={
                "X-CSRF-Token": pre.json()["csrf_token"],
                "X-Lexicona-Expected-Principal": "anonymous",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert set(data) == {"user", "csrf_token"}
        assert set(data["user"]) == {"id", "login", "display_name", "role", "version"}
        assert data["user"]["login"] == "admin" and data["user"]["role"] == "admin"
        assert data["csrf_token"] != pre.json()["csrf_token"]
        assert (
            client.cookies[COOKIE] != old_cookie
            and response.headers[STAMP] == "anonymous"
        )
        assert "Max-Age=2592000" in response.headers["set-cookie"]
        current = await client.get("/api/v1/auth/csrf")
        assert current.json() == {
            "csrf_token": data["csrf_token"],
            "authenticated": True,
        }
        assert current.headers[STAMP] == "user:" + data["user"]["id"]
        assert "set-cookie" not in current.headers
    with closing(sqlite3.connect(path)) as connection:
        rows = connection.execute(
            "SELECT user_id,revoked_at,absolute_expires_at-created_at "
            "FROM auth_sessions ORDER BY created_at"
        ).fetchall()
        assert len(rows) == 2 and rows[0][0] is None and rows[0][1] is not None
        assert rows[1] == (data["user"]["id"], None, 2592000000000)


@dataclass(repr=False)
class SignedIn:
    path: Path
    client: httpx.AsyncClient
    auth: httpx.Response
    clock: list[datetime]


@pytest.fixture
async def signed_in(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> AsyncIterator[SignedIn]:
    import secrets

    from lexicona.operations.admin import main

    path = tmp_path / "account.sqlite3"
    await asyncio.to_thread(migrate, path)
    url = f"sqlite+aiosqlite:///{path}"
    monkeypatch.setenv("LEXICONA_DATABASE_URL", url)
    secret = secrets.token_urlsafe(24)
    assert (
        await asyncio.to_thread(
            main,
            ["bootstrap", "--login", "admin", "--display-name", "Имя"],
            prompt=lambda: secret,
        )
        == 0
    )
    assert secret not in capsys.readouterr().out
    clock = [datetime(2026, 10, 21, tzinfo=UTC)]
    app = create_app(url, clock=lambda: clock[0])
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client,
    ):
        pre = await client.get("/api/v1/auth/csrf")
        auth = await client.post(
            "/api/v1/auth/login",
            json={"login": "admin", "password": secret},
            headers={
                "X-CSRF-Token": pre.json()["csrf_token"],
                "X-Lexicona-Expected-Principal": "anonymous",
            },
        )
        assert auth.status_code == 200
        secret = ""
        yield SignedIn(path, client, auth, clock)


async def test_me_uses_cookie_identity_and_throttled_touch(signed_in: SignedIn) -> None:
    account = signed_in
    user = account.auth.json()["user"]
    marker = "user:" + user["id"]
    response = await account.client.get("/api/v1/auth/me")
    assert response.status_code == 200
    assert response.json() == {"user": user}
    assert response.headers[STAMP] == marker
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers
    with closing(sqlite3.connect(account.path)) as connection:
        original = connection.execute(
            "SELECT last_seen_at,expires_at,absolute_expires_at "
            "FROM auth_sessions WHERE user_id IS NOT NULL"
        ).fetchone()
    account.clock[0] += timedelta(microseconds=299999999)
    assert (await account.client.get("/api/v1/auth/me")).status_code == 200
    with closing(sqlite3.connect(account.path)) as connection:
        assert (
            connection.execute(
                "SELECT last_seen_at,expires_at,absolute_expires_at "
                "FROM auth_sessions WHERE user_id IS NOT NULL"
            ).fetchone()
            == original
        )
    account.clock[0] += timedelta(microseconds=1)
    touched = await account.client.get("/api/v1/auth/me")
    assert touched.status_code == 200 and touched.headers[STAMP] == marker
    assert touched.json() == {"user": user} and "set-cookie" not in touched.headers
    with closing(sqlite3.connect(account.path)) as connection:
        now = original[0] + 300000000
        assert connection.execute(
            "SELECT last_seen_at,expires_at,absolute_expires_at "
            "FROM auth_sessions WHERE user_id IS NOT NULL"
        ).fetchone() == (now, now + 604800000000, original[2])
        connection.execute("UPDATE users SET is_active=0,version=version+1")
        connection.commit()
    rejected = await account.client.get("/api/v1/auth/me")
    assert rejected.status_code == 401 and rejected.headers[STAMP] == "anonymous"
    assert rejected.json()["error"]["code"] == "auth_required"
    assert "set-cookie" not in rejected.headers
    account.client.cookies.clear()
    missing = await account.client.get("/api/v1/auth/me")
    assert missing.status_code == 401 and missing.headers[STAMP] == "anonymous"
    assert "set-cookie" not in missing.headers


async def test_logout_rotates_to_pre_auth_and_revokes_old_cookie(
    signed_in: SignedIn,
) -> None:
    account = signed_in
    old_cookie = account.client.cookies[COOKIE]
    old_csrf = account.auth.json()["csrf_token"]
    marker = "user:" + account.auth.json()["user"]["id"]
    with closing(sqlite3.connect(account.path)) as connection:
        before = connection.execute(
            "SELECT * FROM auth_sessions ORDER BY id"
        ).fetchall()
    rejected = await account.client.post(
        "/api/v1/auth/logout",
        json={},
        headers={
            "X-CSRF-Token": old_csrf,
            "X-Lexicona-Expected-Principal": "anonymous",
        },
    )
    assert rejected.status_code == 412
    assert rejected.json()["error"]["code"] == "principal_mismatch"
    assert rejected.headers[STAMP] == marker and "set-cookie" not in rejected.headers
    with closing(sqlite3.connect(account.path)) as connection:
        assert (
            connection.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
            == before
        )
    response = await account.client.post(
        "/api/v1/auth/logout",
        json={},
        headers={"X-CSRF-Token": old_csrf, "X-Lexicona-Expected-Principal": marker},
    )
    assert response.status_code == 200
    data = response.json()
    assert (
        set(data) == {"csrf_token", "authenticated"} and data["authenticated"] is False
    )
    assert data["csrf_token"] != old_csrf
    assert response.headers[STAMP] == marker
    assert response.headers["cache-control"] == "no-store"
    assert "Max-Age=1800" in response.headers["set-cookie"]
    assert account.client.cookies[COOKIE] != old_cookie
    current = await account.client.get("/api/v1/auth/csrf")
    assert current.json() == data and current.headers[STAMP] == "anonymous"
    assert "set-cookie" not in current.headers
    missing = await account.client.get("/api/v1/auth/me")
    assert missing.status_code == 401 and missing.headers[STAMP] == "anonymous"
    stale = await account.client.post(
        "/api/v1/auth/logout",
        json={},
        headers={
            "Cookie": COOKIE + "=" + old_cookie,
            "X-CSRF-Token": old_csrf,
            "X-Lexicona-Expected-Principal": marker,
        },
    )
    assert stale.status_code == 401 and stale.headers[STAMP] == "anonymous"
    assert stale.json()["error"]["code"] == "auth_required"
    assert "set-cookie" not in stale.headers
    stale_me = await account.client.get(
        "/api/v1/auth/me",
        headers={"Cookie": COOKIE + "=" + old_cookie},
    )
    assert stale_me.status_code == 401 and stale_me.headers[STAMP] == "anonymous"
    assert "set-cookie" not in stale_me.headers
    with closing(sqlite3.connect(account.path)) as connection:
        rows = connection.execute(
            "SELECT user_id,revoked_at,expires_at-created_at,"
            "absolute_expires_at-created_at,token_hash,csrf_token "
            "FROM auth_sessions ORDER BY created_at,id"
        ).fetchall()
    assert len(rows) == 3
    assert sum(row[1] is None for row in rows) == 1
    active = next(row for row in rows if row[1] is None)
    digest = hashlib.sha256(
        base64.urlsafe_b64decode(account.client.cookies[COOKIE] + "=")
    ).digest()
    assert active == (None, None, 1800000000, 1800000000, digest, data["csrf_token"])
    # P -> P is also a committed rotation, authorized by the old anonymous P.
    previous = account.client.cookies[COOKIE]
    again = await account.client.post(
        "/api/v1/auth/logout",
        json={},
        headers={
            "X-CSRF-Token": data["csrf_token"],
            "X-Lexicona-Expected-Principal": "anonymous",
        },
    )
    assert again.status_code == 200 and again.headers[STAMP] == "anonymous"
    assert again.json()["authenticated"] is False
    assert again.json()["csrf_token"] != data["csrf_token"]
    assert account.client.cookies[COOKIE] != previous


ORIGIN = "http://127.0.0.1:5173"
STAMP = "x-lexicona-request-principal"
COOKIE = "lexicona_session_dev"


async def test_csrf_bootstrap_reuses_server_session_without_cookie_refresh(
    tmp_path: Path,
) -> None:
    path = tmp_path / "http.sqlite3"
    await asyncio.to_thread(migrate, path)
    app = create_app(f"sqlite+aiosqlite:///{path}")
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client,
    ):
        first = await client.get("/api/v1/auth/csrf")
        assert first.status_code == 200
        data = first.json()
        assert (
            set(data) == {"csrf_token", "authenticated"}
            and data["authenticated"] is False
        )
        assert len(base64.urlsafe_b64decode(data["csrf_token"] + "=")) == 32
        cookie = client.cookies[COOKIE]
        assert len(base64.urlsafe_b64decode(cookie + "=")) == 32
        assert cookie != data["csrf_token"]
        assert first.headers[STAMP] == "anonymous"
        assert UUID(first.headers["x-request-id"]).version == 4
        assert first.headers["cache-control"] == "no-store"
        assert "HttpOnly" in first.headers["set-cookie"]
        assert "Max-Age=1800" in first.headers["set-cookie"]
        again = await client.get("/api/v1/auth/csrf")
        assert again.json() == data and "set-cookie" not in again.headers
        assert again.headers["x-request-id"] != first.headers["x-request-id"]
    with closing(sqlite3.connect(path)) as connection:
        rows = connection.execute(
            "SELECT token_hash,csrf_token,user_id,expires_at-created_at,"
            "absolute_expires_at-expires_at FROM auth_sessions"
        ).fetchall()
    assert rows == [
        (
            hashlib.sha256(base64.urlsafe_b64decode(cookie + "=")).digest(),
            data["csrf_token"],
            None,
            1800000000,
            0,
        )
    ]

"""TTL boundaries are authoritative in SQLite, independent of cookie expiry."""

import asyncio
import sqlite3
from contextlib import closing
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
from asgi_lifespan import LifespanManager
from test_auth_http import COOKIE, ORIGIN, STAMP, SignedIn, signed_in
from test_auth_schema import migrate

from lexicona.app import create_app
from lexicona.auth.sessions import ABS_US, IDLE_US, P_US
from lexicona.auth.values import epoch_microseconds

__all__ = ["signed_in"]


@pytest.mark.parametrize("absolute", [False, True])
@pytest.mark.parametrize("offset", [-1, 0, 1], ids=["minus1us", "equality", "plus1us"])
async def test_a_expiry_boundary_never_revives(
    signed_in: SignedIn, absolute: bool, offset: int
) -> None:
    a = signed_in
    origin = a.clock[0]
    created = epoch_microseconds(origin)
    if absolute:
        with closing(sqlite3.connect(a.path)) as db:
            db.execute(
                (
                    "UPDATE auth_sessions SET "
                    "last_seen_at=?,expires_at=absolute_expires_at WHERE user_id IS"
                    " NOT NULL"
                ),
                (created + ABS_US - IDLE_US,),
            )
            db.commit()
    a.clock[0] = origin + timedelta(
        microseconds=(ABS_US if absolute else IDLE_US) + offset
    )
    with closing(sqlite3.connect(a.path)) as db:
        before = db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
    response = await a.client.get("/api/v1/auth/me")
    assert response.status_code == (200 if offset < 0 else 401)
    assert "set-cookie" not in response.headers
    with closing(sqlite3.connect(a.path)) as db:
        if offset >= 0:
            assert (
                db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
                == before
            )
        else:
            now = epoch_microseconds(a.clock[0])
            assert db.execute(
                "SELECT last_seen_at,expires_at,absolute_expires_at FROM "
                "auth_sessions WHERE user_id IS NOT NULL"
            ).fetchone() == (
                now,
                min(now + IDLE_US, created + ABS_US),
                created + ABS_US,
            )
    if offset >= 0:
        assert response.headers[STAMP] == "anonymous"
        response = await a.client.get("/api/v1/auth/csrf")
        assert response.status_code == 200 and response.json()["authenticated"] is False
        assert response.headers[STAMP] == "anonymous"
        with closing(sqlite3.connect(a.path)) as db:
            assert db.execute(
                "SELECT * FROM auth_sessions WHERE user_id IS NOT NULL"
            ).fetchall() == [r for r in before if r[1] is not None]


@pytest.mark.parametrize("offset", [-1, 0, 1], ids=["minus1us", "equality", "plus1us"])
async def test_p_thirty_minute_non_sliding(signed_in: SignedIn, offset: int) -> None:
    a = signed_in
    a.client.cookies.clear()
    pre = await a.client.get("/api/v1/auth/csrf")
    csrf = pre.json()["csrf_token"]
    cookie = a.client.cookies[COOKIE]
    with closing(sqlite3.connect(a.path)) as db:
        before = db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
    a.clock[0] += timedelta(microseconds=P_US + offset)
    response = await a.client.post(
        "/api/v1/auth/logout",
        json={},
        headers={"X-CSRF-Token": csrf, "X-Lexicona-Expected-Principal": "anonymous"},
    )
    assert response.status_code == (200 if offset < 0 else 401)
    if offset >= 0:
        assert (
            "set-cookie" not in response.headers and a.client.cookies[COOKIE] == cookie
        )
        with closing(sqlite3.connect(a.path)) as db:
            assert (
                db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
                == before
            )
    else:
        assert a.client.cookies[COOKIE] != cookie


async def test_p_csrf_reads_never_slide(signed_in: SignedIn) -> None:
    a = signed_in
    a.client.cookies.clear()
    pre = await a.client.get("/api/v1/auth/csrf")
    with closing(sqlite3.connect(a.path)) as db:
        before = db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
    for delta in [300000000, 1499999999]:
        a.clock[0] += timedelta(microseconds=delta)
        response = await a.client.get("/api/v1/auth/csrf")
        assert response.json() == pre.json() and "set-cookie" not in response.headers
        with closing(sqlite3.connect(a.path)) as db:
            assert (
                db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
                == before
            )


async def test_schema_mismatch_is_safe_unavailable(tmp_path: Path) -> None:
    path = tmp_path / "schema.sqlite3"
    await asyncio.to_thread(migrate, path)
    with closing(sqlite3.connect(path)) as db:
        db.execute("UPDATE alembic_version SET version_num='0001_foundation'")
        db.commit()
    app = create_app(f"sqlite+aiosqlite:///{path}")
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client,
    ):
        response = await client.get("/api/v1/auth/csrf")
        assert response.status_code == 503 and response.headers["retry-after"] == "1"
        assert response.json()["error"]["code"] == "service_unavailable"
        assert (
            response.headers[STAMP] == "anonymous"
            and "set-cookie" not in response.headers
        )

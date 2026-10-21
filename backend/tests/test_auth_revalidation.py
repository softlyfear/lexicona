"""Real schema and late active-state rechecks; no anonymous fallback success."""

import asyncio
import sqlite3
from contextlib import closing
from time import monotonic

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import JSONResponse
from starlette.types import Receive, Scope, Send
from test_auth_http import COOKIE, ORIGIN, STAMP, SignedIn, signed_in

from lexicona.auth import boundary
from lexicona.auth.boundary import AuthBoundary
from lexicona.auth.config import token_hash
from lexicona.auth.errors import Decision
from lexicona.auth.rates import Rates
from lexicona.auth.sessions import Session, Sessions

__all__ = ["signed_in"]


async def test_schema_mismatch_has_no_auth_effect(signed_in: SignedIn) -> None:
    a = signed_in
    with closing(sqlite3.connect(a.path)) as db:
        before = db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
        db.execute("UPDATE alembic_version SET version_num='unknown_schema'")
        db.commit()
    response = await a.client.get("/api/v1/auth/me")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_unavailable"
    assert (
        response.headers[STAMP] == "anonymous" and "set-cookie" not in response.headers
    )
    with closing(sqlite3.connect(a.path)) as db:
        assert (
            db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall() == before
        )


async def test_csrf_final_guard_reuses_session_restored_between_uows(
    signed_in: SignedIn, monkeypatch: pytest.MonkeyPatch
) -> None:
    a = signed_in
    with closing(sqlite3.connect(a.path)) as db:
        db.execute("UPDATE users SET is_active=0")
        db.commit()
    original = Sessions.resolve
    calls = 0

    async def restore(
        self: Sessions, db: AsyncSession, digest: bytes | None, now: int
    ) -> Session | None:
        nonlocal calls
        result = await original(self, db, digest, now)
        calls += 1
        if calls == 1:
            assert result is None
            with closing(sqlite3.connect(a.path)) as other:
                other.execute("UPDATE users SET is_active=1")
                other.commit()
        return result

    monkeypatch.setattr(Sessions, "resolve", restore)
    response = await a.client.get("/api/v1/auth/csrf")
    assert calls == 2
    assert response.status_code == 200 and response.json() == {
        "csrf_token": a.auth.json()["csrf_token"],
        "authenticated": True,
    }
    assert response.headers[STAMP] == "user:" + a.auth.json()["user"]["id"]
    assert "set-cookie" not in response.headers
    with closing(sqlite3.connect(a.path)) as db:
        assert db.execute("SELECT count(*) FROM auth_sessions").fetchone() == (2,)
        assert db.execute(
            "SELECT count(*) FROM auth_sessions WHERE token_hash=?",
            (token_hash(a.client.cookies[COOKIE]),),
        ).fetchone() == (1,)


async def test_boundary_rejects_success_prepared_after_response_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        boundary, "Decision", lambda deadline: Decision(monotonic() + 0.02)
    )

    async def delayed(scope: Scope, receive: Receive, send: Send) -> None:
        await asyncio.sleep(0.03)
        response = JSONResponse(
            {"synthetic": "not-private"}, headers={"Set-Cookie": "must-not-be-sent"}
        )
        await response(scope, receive, send)

    app = AuthBoundary(delayed, Rates())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN
    ) as client:
        response = await client.get("/api/v1/auth/csrf")
    assert (
        response.status_code == 408
        and response.json()["error"]["code"] == "request_timeout"
    )
    assert "set-cookie" not in response.headers
    assert response.headers[STAMP] == "anonymous"

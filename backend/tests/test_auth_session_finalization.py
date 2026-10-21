"""Committed effects never imply a still-valid browser credential or response."""

import asyncio
import sqlite3
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from asgi_lifespan import LifespanManager
from test_auth_http import ORIGIN
from test_auth_schema import migrate

from lexicona.app import create_app


async def test_csrf_does_not_issue_already_expired_committed_pre_auth(
    tmp_path: Path,
) -> None:
    path = tmp_path / "committed-expiry.sqlite3"
    await asyncio.to_thread(migrate, path)
    calls = 0
    now = datetime(2026, 10, 21, tzinfo=UTC)

    def clock() -> datetime:
        nonlocal calls
        calls += 1
        return now + (timedelta(minutes=30) if calls >= 3 else timedelta())

    app = create_app(f"sqlite+aiosqlite:///{path}", clock=clock)
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client,
    ):
        response = await client.get("/api/v1/auth/csrf")
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "auth_required"
        assert "set-cookie" not in response.headers
    with closing(sqlite3.connect(path)) as db:
        assert db.execute("SELECT count(*) FROM auth_sessions").fetchone() == (1,)

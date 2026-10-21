"""Cookie lifetime is bound to committed DB time, not a later response clock."""

import asyncio
import sqlite3
from contextlib import closing
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx
import pytest
from asgi_lifespan import LifespanManager
from test_auth_schema import migrate
from test_login_rates_http import ORIGIN, pre_auth

from lexicona.app import create_app


@pytest.mark.parametrize("rotation", [False, True])
async def test_expires_is_committed_absolute_expiry(
    tmp_path: Path, rotation: bool
) -> None:
    path = tmp_path / "cookie.sqlite3"
    await asyncio.to_thread(migrate, path)
    now = datetime(2026, 10, 21, tzinfo=UTC)

    def advancing_clock() -> datetime:
        nonlocal now
        now += timedelta(seconds=1)
        return now

    app = create_app(f"sqlite+aiosqlite:///{path}", clock=advancing_clock)
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client,
    ):
        headers = await pre_auth(client)
        if rotation:
            response = await client.post(
                "/api/v1/auth/logout", headers=headers, json={}
            )
        else:
            client.cookies.clear()
            response = await client.get("/api/v1/auth/csrf")
        assert response.status_code == 200
        expires = parsedate_to_datetime(
            response.headers["set-cookie"].split("expires=", 1)[1].split(";", 1)[0]
        )
        with closing(sqlite3.connect(path)) as connection:
            absolute = connection.execute(
                "SELECT max(absolute_expires_at) FROM auth_sessions"
            ).fetchone()[0]
        epoch = datetime(1970, 1, 1, tzinfo=UTC)
        assert expires == epoch + timedelta(microseconds=absolute)
        assert "Max-Age=1800" in response.headers["set-cookie"]

"""Authenticated CSRF reads follow the same session metadata policy as me."""

import sqlite3
from contextlib import closing
from datetime import timedelta

from test_auth_http import STAMP, SignedIn, signed_in

__all__ = ["signed_in"]


async def test_authenticated_csrf_touches_without_rotation(signed_in: SignedIn) -> None:
    account = signed_in
    with closing(sqlite3.connect(account.path)) as connection:
        original = connection.execute(
            "SELECT last_seen_at,absolute_expires_at FROM auth_sessions WHERE "
            "user_id IS NOT NULL"
        ).fetchone()
    account.clock[0] += timedelta(microseconds=299999999)
    response = await account.client.get("/api/v1/auth/csrf")
    assert response.status_code == 200 and "set-cookie" not in response.headers
    with closing(sqlite3.connect(account.path)) as connection:
        assert connection.execute(
            "SELECT last_seen_at FROM auth_sessions WHERE user_id IS NOT NULL"
        ).fetchone() == (original[0],)
    account.clock[0] += timedelta(microseconds=1)
    response = await account.client.get("/api/v1/auth/csrf")
    assert response.json() == {
        "csrf_token": account.auth.json()["csrf_token"],
        "authenticated": True,
    }
    assert response.headers[STAMP] == "user:" + account.auth.json()["user"]["id"]
    assert "set-cookie" not in response.headers
    with closing(sqlite3.connect(account.path)) as connection:
        assert connection.execute(
            "SELECT last_seen_at,expires_at,absolute_expires_at FROM "
            "auth_sessions WHERE user_id IS NOT NULL"
        ).fetchone() == (
            original[0] + 300000000,
            original[0] + 300000000 + 604800000000,
            original[1],
        )

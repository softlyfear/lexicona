"""Query validation precedes every auth metadata/business effect."""

import sqlite3
from contextlib import closing
from datetime import timedelta

import pytest
from test_auth_http import COOKIE, STAMP, SignedIn, signed_in

__all__ = ["signed_in"]


@pytest.mark.parametrize("route", ["csrf", "me", "logout", "login"])
@pytest.mark.parametrize("query", ["?secret_canary=value", "?limit=1&limit=2"])
async def test_query_rejected_without_touch_or_rotation(
    signed_in: SignedIn, route: str, query: str
) -> None:
    account = signed_in
    account.clock[0] += timedelta(minutes=5)
    marker = "user:" + account.auth.json()["user"]["id"]
    if route == "login":
        # Obtain a distinct P without changing the A row used by the other cases.
        account.client.cookies.clear()
        pre = await account.client.get("/api/v1/auth/csrf")
        csrf = pre.json()["csrf_token"]
        marker = "anonymous"
    else:
        csrf = account.auth.json()["csrf_token"]
    with closing(sqlite3.connect(account.path)) as connection:
        before = connection.execute(
            "SELECT * FROM auth_sessions ORDER BY id"
        ).fetchall()
    path = "/api/v1/auth/" + route + query
    if route in {"login", "logout"}:
        response = await account.client.post(
            path,
            json={},
            headers={"X-CSRF-Token": csrf, "X-Lexicona-Expected-Principal": marker},
        )
    else:
        response = await account.client.get(path)
    assert response.status_code == 422
    assert response.json()["error"]["fields"] == {
        "_request": ["Лишние поля запрещены."]
    }
    assert "secret_canary" not in response.text
    assert "set-cookie" not in response.headers
    with closing(sqlite3.connect(account.path)) as connection:
        assert (
            connection.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
            == before
        )


async def test_query_does_not_override_unsafe_auth_state(signed_in: SignedIn) -> None:
    account = signed_in
    marker = "user:" + account.auth.json()["user"]["id"]
    headers = {
        "X-CSRF-Token": account.auth.json()["csrf_token"],
        "X-Lexicona-Expected-Principal": marker,
    }
    response = await account.client.post(
        "/api/v1/auth/login?extra=1", headers=headers, json={}
    )
    assert response.status_code == 409
    response = await account.client.post("/api/v1/auth/logout?extra=1", json={})
    assert response.status_code == 403
    account.client.cookies.clear()
    for route in ["me", "logout", "login"]:
        response = await account.client.request(
            "GET" if route == "me" else "POST", "/api/v1/auth/" + route + "?extra=1"
        )
        assert response.status_code == 401 and response.headers[STAMP] == "anonymous"
    assert COOKIE not in account.client.cookies

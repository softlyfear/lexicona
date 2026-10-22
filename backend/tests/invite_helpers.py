"""Shared test-only invite HTTP setup; no secret defaults or persisted payloads."""

import secrets
import sqlite3
from collections.abc import AsyncIterator
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
from test_auth_http import ORIGIN, SignedIn
from test_auth_http import signed_in as signed_in

__all__ = ["signed_in"]

CREATE = "/api/v1/admin/invites"
REGISTER = "/api/v1/auth/register"


def admin_headers(account: SignedIn) -> dict[str, str]:
    return {
        "X-CSRF-Token": account.auth.json()["csrf_token"],
        "X-Lexicona-Expected-Principal": "user:" + account.auth.json()["user"]["id"],
    }


def snapshot(path: Path) -> list[list[tuple[object, ...]]]:
    with closing(sqlite3.connect(path)) as db:
        return [
            db.execute("SELECT * FROM " + table + " ORDER BY 1").fetchall()
            for table in ["users", "user_settings", "invites", "auth_sessions"]
        ]


@dataclass(repr=False)
class Registration:
    account: SignedIn
    client: httpx.AsyncClient
    headers: dict[str, str]
    data: dict[str, object]
    id: str


@pytest.fixture
async def registration(signed_in: SignedIn) -> AsyncIterator[Registration]:
    account = signed_in
    response = await account.client.post(
        CREATE, json={}, headers=admin_headers(account)
    )
    assert response.status_code == 201
    async with httpx.AsyncClient(
        transport=account.client._transport, base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        pre = await client.get("/api/v1/auth/csrf")
        assert pre.status_code == 200
        yield Registration(
            account,
            client,
            {
                "X-CSRF-Token": pre.json()["csrf_token"],
                "X-Lexicona-Expected-Principal": "anonymous",
            },
            {
                "login": "new_user",
                "display_name": " Имя e\u0301 ",
                "password": " \n😀" + secrets.token_urlsafe(24) + " ",
                "invite_token": response.json()["invite_token"],
            },
            response.json()["invite"]["id"],
        )

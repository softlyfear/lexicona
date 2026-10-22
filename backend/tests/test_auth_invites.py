"""Phase2B tracer: real HTTP and independent P credentials on file WAL."""

import asyncio
import secrets
import sqlite3
from contextlib import closing
from datetime import timedelta
from pathlib import Path
from threading import Barrier

import httpx
import pytest
from asgi_lifespan import LifespanManager
from test_auth_http import COOKIE, ORIGIN, STAMP, SignedIn
from test_auth_http import signed_in as signed_in
from test_auth_schema import migrate

from lexicona.app import create_app
from lexicona.auth.passwords import ArgonHasher, Hasher
from lexicona.operations.admin import main


async def test_admin_create_list_and_two_pre_auth_redeem_one_invite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "invites.sqlite3"
    await asyncio.to_thread(migrate, path)
    url = f"sqlite+aiosqlite:///{path}"
    monkeypatch.setenv("LEXICONA_DATABASE_URL", url)
    password = secrets.token_urlsafe(24)
    assert (
        await asyncio.to_thread(
            main,
            ["bootstrap", "--login", "admin", "--display-name", "Администратор"],
            prompt=lambda: password,
        )
        == 0
    )
    assert password not in capsys.readouterr().out
    native = ArgonHasher()
    barrier = Barrier(2, timeout=5)
    hashes = 0

    def hash_password(value: str) -> str:
        nonlocal hashes
        hashes += 1
        # The lifespan dummy is first. Both registration hashes must arrive
        # together while an independent writer can still acquire the WAL lock.
        if hashes > 1:
            barrier.wait()
            with closing(sqlite3.connect(path)) as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.rollback()
        return native.hash(value)

    app = create_app(url, password_hasher=Hasher(hash_password, native.verify))
    transport = httpx.ASGITransport(app=app)
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=transport, base_url=ORIGIN, headers={"Origin": ORIGIN}
        ) as admin,
        httpx.AsyncClient(
            transport=transport, base_url=ORIGIN, headers={"Origin": ORIGIN}
        ) as first,
        httpx.AsyncClient(
            transport=transport, base_url=ORIGIN, headers={"Origin": ORIGIN}
        ) as second,
    ):
        pre = await admin.get("/api/v1/auth/csrf")
        auth = await admin.post(
            "/api/v1/auth/login",
            json={"login": "admin", "password": password},
            headers={
                "X-CSRF-Token": pre.json()["csrf_token"],
                "X-Lexicona-Expected-Principal": "anonymous",
            },
        )
        assert auth.status_code == 200
        marker = "user:" + auth.json()["user"]["id"]
        created = await admin.post(
            "/api/v1/admin/invites",
            json={},
            headers={
                "X-CSRF-Token": auth.json()["csrf_token"],
                "X-Lexicona-Expected-Principal": marker,
            },
        )
        assert created.status_code == 201
        assert created.headers[STAMP] == marker
        invite = created.json()["invite"]
        raw_token = created.json()["invite_token"]
        listed = await admin.get("/api/v1/admin/invites")
        assert listed.status_code == 200
        assert listed.json() == {"items": [invite], "next_cursor": None}
        assert raw_token not in listed.text
        assert "token_hash" not in listed.text and "used_by" not in listed.text
        p1, p2 = await asyncio.gather(
            first.get("/api/v1/auth/csrf"), second.get("/api/v1/auth/csrf")
        )
        old = [first.cookies[COOKIE], second.cookies[COOKIE]]
        results = await asyncio.gather(
            *(
                client.post(
                    "/api/v1/auth/register",
                    json={
                        "invite_token": raw_token,
                        "login": login,
                        "display_name": "Пользователь",
                        "password": secrets.token_urlsafe(24),
                    },
                    headers={
                        "X-CSRF-Token": csrf.json()["csrf_token"],
                        "X-Lexicona-Expected-Principal": "anonymous",
                    },
                )
                for client, csrf, login in [
                    (first, p1, "first"),
                    (second, p2, "second"),
                ]
            )
        )
        assert sorted(response.status_code for response in results) == [201, 400]
        winner = next(response for response in results if response.status_code == 201)
        loser = next(response for response in results if response.status_code == 400)
        assert loser.json()["error"]["code"] == "invite_invalid"
        assert "set-cookie" not in loser.headers
        assert all(response.headers[STAMP] == "anonymous" for response in results)
        assert all(
            response.headers["cache-control"] == "no-store"
            for response in [created, listed, *results]
        )
        assert (
            sum(
                client.cookies[COOKIE] != cookie
                for client, cookie in zip([first, second], old, strict=True)
            )
            == 1
        )
        user = winner.json()["user"]
        assert set(user) == {"id", "login", "display_name", "role", "version"}
        assert user["role"] == "user" and user["version"] == 1
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone() == ("wal",)
        assert connection.execute(
            "SELECT count(*) FROM users WHERE role='user'"
        ).fetchone() == (1,)
        assert connection.execute("SELECT count(*) FROM user_settings").fetchone() == (
            2,
        )
        assert connection.execute(
            "SELECT used_by,version,revoked_at FROM invites WHERE used_at IS NOT NULL"
        ).fetchall() == [(user["id"], 2, None)]
        assert connection.execute(
            "SELECT count(*) FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL",
            (user["id"],),
        ).fetchone() == (1,)
        assert connection.execute(
            "SELECT count(*) FROM auth_sessions "
            "WHERE user_id IS NULL AND revoked_at IS NOT NULL"
        ).fetchone() == (1,)
        # csrf issuance legitimately cleans the earlier revoked admin P. The
        # registration race itself revokes exactly one of its independent Ps.
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.parametrize("state", ["active", "revoked", "used", "expired"])
async def test_revoke_version_precedes_state_and_current_revoked_is_idempotent(
    signed_in: SignedIn, state: str
) -> None:
    account = signed_in
    headers = {
        "X-CSRF-Token": account.auth.json()["csrf_token"],
        "X-Lexicona-Expected-Principal": "user:" + account.auth.json()["user"]["id"],
    }
    created = await account.client.post(
        "/api/v1/admin/invites", json={}, headers=headers
    )
    assert created.status_code == 201
    invite = created.json()["invite"]
    id = invite["id"]
    with closing(sqlite3.connect(account.path)) as db:
        created_at = db.execute(
            "SELECT created_at FROM invites WHERE id=?", (id,)
        ).fetchone()[0]
        if state == "revoked":
            db.execute(
                "UPDATE invites SET revoked_at=created_at,version=2 WHERE id=?", (id,)
            )
        elif state == "used":
            db.execute(
                "UPDATE invites SET used_at=created_at,version=2 WHERE id=?", (id,)
            )
        elif state == "expired":
            account.clock[0] += timedelta(hours=72)
        db.commit()
    route = "/api/v1/admin/invites/" + id + "/revoke"
    stale = await account.client.post(
        route, json={"expected_version": 3}, headers=headers
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "version_conflict"
    version = 2 if state in {"used", "revoked"} else 1
    current = await account.client.post(
        route, json={"expected_version": version}, headers=headers
    )
    if state in {"used", "expired"}:
        assert current.status_code == 409
        assert current.json()["error"]["code"] == "invite_state_conflict"
    else:
        assert current.status_code == 200
        assert current.json()["state"] == "revoked" and current.json()["version"] == 2
        again = await account.client.post(
            route, json={"expected_version": 2}, headers=headers
        )
        assert again.status_code == 200 and again.json() == current.json()
        assert created.json()["invite_token"] not in current.text
    assert "set-cookie" not in current.headers
    assert current.headers[STAMP] == headers["X-Lexicona-Expected-Principal"]
    with closing(sqlite3.connect(account.path)) as db:
        row = db.execute(
            "SELECT used_at,revoked_at,version FROM invites WHERE id=?", (id,)
        ).fetchone()
        assert row == (
            (created_at, None, 2)
            if state == "used"
            else (None, None, 1)
            if state == "expired"
            else (None, created_at, 2)
        )

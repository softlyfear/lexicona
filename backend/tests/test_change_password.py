import asyncio
import threading

import pytest
from fastapi import FastAPI
from sqlalchemy import select

from lexicona.infrastructure.db import Database
from lexicona.infrastructure.models import AuthSession, User
from lexicona.infrastructure.security import LoginThrottle, hash_password, verify_password
from lexicona.interfaces.http.deps import SESSION_COOKIE
from lexicona.interfaces.http.routers import auth
from tests.conftest import PASSWORD, Client, _client

NEW_PASSWORD = "  новая🔑пароль  "
URL = "/api/auth/change-password"


async def test_rotate_session_and_keep_other_owner(
    app: FastAPI, alice: Client, bob: Client, anon: Client
) -> None:
    async with _client(app) as other_session, _client(app) as old_session:
        await other_session.login("alice")
        old_session.cookies.update(alice.cookies)
        old_token = alice.cookies.get(SESSION_COOKIE)
        old_csrf = alice.csrf
        response = await alice.post(
            URL, json={"current_password": PASSWORD, "new_password": NEW_PASSWORD}
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        cookie = response.headers["set-cookie"]
        assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie
        assert alice.cookies.get(SESSION_COOKIE) != old_token
        new_csrf = response.json()["csrf_token"]
        assert new_csrf and new_csrf != old_csrf
        assert response.json()["user"]["login"] == "alice"
        assert (await old_session.get("/api/auth/me")).status_code == 401
        assert (await other_session.get("/api/auth/me")).status_code == 401
        assert (await bob.get("/api/auth/me")).json()["user"]["login"] == "bob"
        assert (await alice.get("/api/auth/me")).json()["csrf_token"] == new_csrf
        assert (
            await alice.put("/api/auth/settings", json={"difficulty": "hard"})
        ).status_code == 403
        alice.headers["X-CSRF-Token"] = new_csrf
        assert (
            await alice.put("/api/auth/settings", json={"difficulty": "hard"})
        ).status_code == 200

        database: Database = app.state.db
        async with database.sessions() as db:
            user = await db.scalar(select(User).where(User.login == "alice"))
            assert user is not None and user.password_hash != NEW_PASSWORD
            sessions = list(
                await db.scalars(select(AuthSession).where(AuthSession.user_id == user.id))
            )
            assert len(sessions) == 1 and sessions[0].token_hash != alice.cookies.get(
                SESSION_COOKIE
            )
        assert (
            await anon.post("/api/auth/login", json={"login": "alice", "password": PASSWORD})
        ).status_code == 401
        assert (
            await anon.post("/api/auth/login", json={"login": "alice", "password": NEW_PASSWORD})
        ).status_code == 200


async def test_wrong_password_is_400_without_logout_or_cookie(alice: Client) -> None:
    old_token = alice.cookies.get(SESSION_COOKIE)
    response = await alice.post(
        URL, json={"current_password": "not right", "new_password": NEW_PASSWORD}
    )
    assert response.status_code == 400
    assert response.json() == {"detail": "invalid_current_password"}
    assert response.headers["cache-control"] == "no-store" and "set-cookie" not in response.headers
    assert alice.cookies.get(SESSION_COOKIE) == old_token
    assert (await alice.get("/api/auth/me")).status_code == 200
    assert (await alice.put("/api/auth/settings", json={"difficulty": "hard"})).status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"current_password": "", "new_password": NEW_PASSWORD},
        {"current_password": "x" * 257, "new_password": NEW_PASSWORD},
        {"current_password": PASSWORD, "new_password": "x" * 11},
        {"current_password": PASSWORD, "new_password": "x" * 129},
        {"current_password": PASSWORD, "new_password": 123456789012},
        {"current_password": True, "new_password": NEW_PASSWORD},
        {"current_password": PASSWORD, "new_password": NEW_PASSWORD, "user_id": "bob"},
        {"current_password": PASSWORD, "new_password": NEW_PASSWORD, "login": "bob"},
    ],
)
async def test_payload_strict(alice: Client, body: dict[str, object]) -> None:
    response = await alice.post(URL, json=body)
    assert response.status_code == 422 and "set-cookie" not in response.headers
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("new_password", ["🔑" * 12, " " + "x" * 10 + " ", "x" * 128])
async def test_new_password_bounds_and_no_trimming(
    alice: Client, anon: Client, new_password: str
) -> None:
    response = await alice.post(
        URL, json={"current_password": PASSWORD, "new_password": new_password}
    )
    assert response.status_code == 200
    response = await anon.post("/api/auth/login", json={"login": "alice", "password": new_password})
    assert response.status_code == 200
    if new_password != new_password.strip():
        assert (
            await anon.post(
                "/api/auth/login", json={"login": "alice", "password": new_password.strip()}
            )
        ).status_code == 401


async def test_auth_csrf_and_independent_throttle(
    alice: Client, anon: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = {"current_password": PASSWORD, "new_password": NEW_PASSWORD}
    assert (await anon.post(URL, json=payload)).status_code == 401
    del alice.headers["X-CSRF-Token"]
    assert (await alice.post(URL, json=payload)).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    monkeypatch.setattr(auth, "password_throttle", LoginThrottle(attempts=2))
    for _ in range(2):
        result = await alice.post(URL, json={**payload, "current_password": "wrong"})
        assert result.status_code == 400
    result = await alice.post(URL, json=payload)
    assert result.status_code == 429 and result.json()["detail"] == "too_many_attempts"
    assert "set-cookie" not in result.headers
    assert (
        await anon.post("/api/auth/login", json={"login": "alice", "password": PASSWORD})
    ).status_code == 200
    assert (await alice.get("/api/auth/me")).status_code == 200


async def test_success_resets_password_throttle(
    alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(auth, "password_throttle", LoginThrottle(attempts=2))
    wrong = {"current_password": "wrong", "new_password": NEW_PASSWORD}
    assert (await alice.post(URL, json=wrong)).status_code == 400
    response = await alice.post(
        URL, json={"current_password": PASSWORD, "new_password": NEW_PASSWORD}
    )
    assert response.status_code == 200
    alice.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    assert (await alice.post(URL, json=wrong)).status_code == 400
    assert (await alice.post(URL, json=wrong)).status_code == 400
    assert (await alice.post(URL, json=wrong)).status_code == 429


async def test_two_simultaneous_password_changes_only_one_wins(
    app: FastAPI, alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    barrier = threading.Barrier(2)
    original = hash_password

    def synchronized_hash(password: str) -> str:
        result = original(password)
        barrier.wait(timeout=15)
        return result

    monkeypatch.setattr(auth, "hash_password", synchronized_hash)
    async with _client(app) as first, _client(app) as second:
        for client in [first, second]:
            client.cookies.update(alice.cookies)
            client.headers["X-CSRF-Token"] = alice.csrf
        results = await asyncio.gather(
            first.post(
                URL, json={"current_password": PASSWORD, "new_password": "first new password"}
            ),
            second.post(
                URL, json={"current_password": PASSWORD, "new_password": "second new password"}
            ),
        )
        assert sorted(response.status_code for response in results) == [200, 401]
        winner = next(response for response in results if response.status_code == 200)
        loser = next(response for response in results if response.status_code == 401)
        assert "set-cookie" not in loser.headers
        assert loser.json() == {"detail": "not_authenticated"}
        winner_client = first if results[0].status_code == 200 else second
        assert (await winner_client.get("/api/auth/me")).json()["csrf_token"] == winner.json()[
            "csrf_token"
        ]


async def test_logout_during_hash_prevents_password_change(
    app: FastAPI, alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = threading.Event()
    proceed = threading.Event()
    original = hash_password

    def wait_hash(password: str) -> str:
        result = original(password)
        started.set()
        assert proceed.wait(timeout=15)
        return result

    monkeypatch.setattr(auth, "hash_password", wait_hash)
    async with _client(app) as concurrent:
        concurrent.cookies.update(alice.cookies)
        concurrent.headers["X-CSRF-Token"] = alice.csrf
        task = asyncio.create_task(
            concurrent.post(URL, json={"current_password": PASSWORD, "new_password": NEW_PASSWORD})
        )
        try:
            assert await asyncio.to_thread(started.wait, 15)
            assert (await alice.post("/api/auth/logout")).status_code == 204
        finally:
            proceed.set()
        response = await task
        assert response.status_code == 401 and "set-cookie" not in response.headers
    async with _client(app) as retry:
        assert (
            await retry.post("/api/auth/login", json={"login": "alice", "password": PASSWORD})
        ).status_code == 200


async def test_login_with_verified_old_hash_cannot_survive_change(
    app: FastAPI, alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = threading.Event()
    proceed = threading.Event()
    original = verify_password

    def wait_first_check(password_hash: str | None, password: str) -> bool:
        result = original(password_hash, password)
        if not started.is_set():
            started.set()
            assert proceed.wait(timeout=15)
        return result

    monkeypatch.setattr(auth, "verify_password", wait_first_check)
    async with _client(app) as stale:
        task = asyncio.create_task(
            stale.post("/api/auth/login", json={"login": "alice", "password": PASSWORD})
        )
        try:
            assert await asyncio.to_thread(started.wait, 15)
            response = await alice.post(
                URL, json={"current_password": PASSWORD, "new_password": NEW_PASSWORD}
            )
            assert response.status_code == 200
        finally:
            proceed.set()
        response = await task
        assert response.status_code == 401 and "set-cookie" not in response.headers
        assert (await stale.get("/api/auth/me")).status_code == 401

"""Deterministic prewrite/CAS races on separate file-backed WAL UoWs."""

import asyncio
import sqlite3
from collections.abc import Callable
from contextlib import closing
from datetime import timedelta
from uuid import uuid4

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from test_auth_http import STAMP, SignedIn, signed_in
from test_login_rates_http import LOGIN, pre_auth
from test_login_rates_resources import Harness, harness

from lexicona.auth.config import token
from lexicona.auth.errors import Decision
from lexicona.auth.passwords import ArgonHasher
from lexicona.auth.sessions import IssuedSession, Session, Sessions, User
from lexicona.auth.values import epoch_microseconds

__all__ = ["harness", "signed_in"]


@pytest.mark.parametrize(
    "change", ["version", "hash", "inactive", "missing", "identity", "csrf", "revoked"]
)
async def test_final_login_guard_rechecks_current_state(
    harness: Harness, change: str
) -> None:
    replacement_hash = ArgonHasher().hash(token()) if change == "hash" else ""

    def change_state() -> None:
        with closing(sqlite3.connect(harness.path)) as db:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA defer_foreign_keys=ON")
            if change == "version":
                db.execute("UPDATE users SET version=version+1")
            elif change == "hash":
                db.execute("UPDATE users SET password_hash=?", (replacement_hash,))
            elif change == "inactive":
                db.execute("UPDATE users SET is_active=0")
            elif change == "missing":
                db.execute("UPDATE users SET login='renamed'")
            elif change == "identity":
                replacement = str(uuid4())
                user = db.execute("SELECT * FROM users").fetchone()
                settings = db.execute("SELECT * FROM user_settings").fetchone()
                db.execute("DELETE FROM users")
                db.execute(
                    "INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)",
                    (replacement, *user[1:]),
                )
                db.execute(
                    "INSERT INTO user_settings VALUES (?,?,?,?,?,?,?,?,?)",
                    (replacement, *settings[1:]),
                )
            elif change == "csrf":
                db.execute("UPDATE auth_sessions SET csrf_token=?", (token(),))
            else:
                db.execute("UPDATE auth_sessions SET revoked_at=created_at")
            db.commit()

    harness.hasher.action = change_state
    async with harness.client() as client:
        headers = await pre_auth(client)
        response = await client.post(
            LOGIN,
            json={"login": "admin", "password": harness.password},
            headers=headers,
        )

        assert response.status_code == (403 if change == "csrf" else 401)
        assert response.json()["error"]["code"] == (
            "csrf_failed"
            if change == "csrf"
            else "auth_required"
            if change == "revoked"
            else "invalid_credentials"
        )
        assert (
            "set-cookie" not in response.headers
            and response.headers[STAMP] == "anonymous"
        )
    with closing(sqlite3.connect(harness.path)) as db:
        assert db.execute(
            "SELECT count(*) FROM auth_sessions WHERE user_id IS NOT NULL"
        ).fetchone() == (0,)
        if change != "revoked":
            assert db.execute(
                "SELECT count(*) FROM auth_sessions WHERE revoked_at IS NOT NULL"
            ).fetchone() == (0,)


async def test_same_pre_auth_simultaneous_login_has_one_winner(
    harness: Harness,
) -> None:
    async with harness.client() as client:
        headers = await pre_auth(client)
        harness.hasher.hold = True
        tasks = [
            asyncio.create_task(
                client.post(
                    LOGIN,
                    headers=headers,
                    json={"login": "admin", "password": harness.password},
                )
            )
            for _ in range(2)
        ]
        try:
            await harness.hasher.wait_started()
            await harness.hasher.wait_started()
            harness.hasher.release.set()
            responses = await asyncio.gather(*tasks)
            assert sorted(r.status_code for r in responses) == [200, 401]
            failed = next(r for r in responses if r.status_code == 401)
            assert (
                failed.json()["error"]["code"] == "auth_required"
                and "set-cookie" not in failed.headers
            )
        finally:
            harness.hasher.release.set()
            await asyncio.gather(*tasks, return_exceptions=True)
    with closing(sqlite3.connect(harness.path)) as db:
        assert db.execute(
            "SELECT count(*) FROM auth_sessions WHERE user_id IS NOT NULL AND "
            "revoked_at IS NULL"
        ).fetchone() == (1,)
        assert db.execute(
            "SELECT count(*) FROM auth_sessions WHERE user_id IS NULL AND "
            "revoked_at IS NOT NULL"
        ).fetchone() == (1,)


async def test_cap_five_serializes_concurrent_logins(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    committed: list[str] = []
    original = Sessions.login
    fixed_now = 1792540800000000
    monkeypatch.setattr(Sessions, "now", lambda self: fixed_now)

    async def record(
        self: Sessions,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session], None],
        candidate: User,
    ) -> tuple[User, IssuedSession]:
        result = await original(self, context, digest, authorize, candidate)
        committed.append(result[1].id)
        return result

    monkeypatch.setattr(Sessions, "login", record)
    clients: list[httpx.AsyncClient] = []
    tasks: list[asyncio.Task[httpx.Response]] = []
    try:
        async with harness.client("192.0.2.100") as seed:
            headers = await pre_auth(seed)
            assert (
                await seed.post(
                    LOGIN,
                    headers=headers,
                    json={"login": "admin", "password": harness.password},
                )
            ).status_code == 200
        for n in range(5):
            client = harness.client(f"192.0.2.{n + 1}")
            clients.append(client)
            headers = await pre_auth(client)
            harness.hasher.hold = True
            tasks.append(
                asyncio.create_task(
                    client.post(
                        LOGIN,
                        headers=headers,
                        json={"login": "admin", "password": harness.password},
                    )
                )
            )
        await harness.hasher.wait_started()
        await harness.hasher.wait_started()
        harness.hasher.release.set()
        responses = await asyncio.gather(*tasks)

        assert all(r.status_code == 200 for r in responses)
        assert len(committed) == 6
        with closing(sqlite3.connect(harness.path)) as db:
            active = {
                r[0]
                for r in db.execute(
                    "SELECT id FROM auth_sessions WHERE user_id IS NOT NULL AND"
                    " revoked_at IS NULL"
                )
            }
            revoked = {
                r[0]
                for r in db.execute(
                    "SELECT id FROM auth_sessions WHERE user_id IS NOT NULL AND"
                    " revoked_at IS NOT NULL"
                )
            }
        # Equal created_at: the smallest old UUID is the deterministic victim.
        victim = min(committed[:5])
        assert revoked == {victim} and active == set(committed) - {victim}
    finally:
        harness.hasher.release.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        for client in clients:
            await client.aclose()


@pytest.mark.parametrize("change", ["revoked", "inactive", "csrf"])
async def test_logout_rechecks_after_preliminary_guard(
    signed_in: SignedIn, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    a = signed_in
    original = Sessions.logout

    async def intervene(
        self: Sessions,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session], None],
        admit: Callable[[], None],
    ) -> IssuedSession:
        with closing(sqlite3.connect(a.path)) as db:
            if change == "revoked":
                db.execute(
                    "UPDATE auth_sessions SET revoked_at=created_at WHERE "
                    "user_id IS NOT NULL"
                )
            elif change == "inactive":
                db.execute("UPDATE users SET is_active=0,version=version+1")
            else:
                db.execute(
                    "UPDATE auth_sessions SET csrf_token=? WHERE user_id IS NOT NULL",
                    (token(),),
                )
            db.commit()
        return await original(self, context, digest, authorize, admit)

    monkeypatch.setattr(Sessions, "logout", intervene)
    response = await a.client.post(
        "/api/v1/auth/logout",
        json={},
        headers={
            "X-CSRF-Token": a.auth.json()["csrf_token"],
            "X-Lexicona-Expected-Principal": "user:" + a.auth.json()["user"]["id"],
        },
    )
    assert response.status_code == (403 if change == "csrf" else 401)
    assert response.headers[STAMP] == (
        "user:" + a.auth.json()["user"]["id"] if change == "csrf" else "anonymous"
    )
    assert "set-cookie" not in response.headers
    with closing(sqlite3.connect(a.path)) as db:
        assert db.execute("SELECT count(*) FROM auth_sessions").fetchone() == (2,)
        if change != "revoked":
            assert db.execute(
                "SELECT count(*) FROM auth_sessions WHERE user_id IS NOT NULL "
                "AND revoked_at IS NOT NULL"
            ).fetchone() == (0,)


async def test_parallel_touch_cas_rechecks_latest_seen(
    signed_in: SignedIn, monkeypatch: pytest.MonkeyPatch
) -> None:
    a = signed_in
    a.clock[0] += timedelta(minutes=5)
    arrived: asyncio.Queue[None] = asyncio.Queue()
    release = asyncio.Event()
    original = Sessions.touch

    async def gated(
        self: Sessions,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session], None],
    ) -> tuple[Session, User]:
        arrived.put_nowait(None)
        await release.wait()
        return await original(self, context, digest, authorize)

    monkeypatch.setattr(Sessions, "touch", gated)
    tasks = [asyncio.create_task(a.client.get("/api/v1/auth/me")) for _ in range(2)]
    try:
        for _ in range(2):
            await asyncio.wait_for(arrived.get(), 1)
        release.set()
        responses = await asyncio.gather(*tasks)
        assert all(
            r.status_code == 200 and "set-cookie" not in r.headers for r in responses
        )
        now = epoch_microseconds(a.clock[0])
        with closing(sqlite3.connect(a.path)) as db:
            assert db.execute(
                "SELECT last_seen_at,expires_at FROM auth_sessions WHERE "
                "user_id IS NOT NULL"
            ).fetchone() == (now, now + 604800000000)
    finally:
        release.set()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize("operation", ["touch", "logout"])
async def test_expiry_between_guard_and_conditional_write_is_no_effect(
    signed_in: SignedIn, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    a = signed_in
    a.clock[0] += timedelta(minutes=5)
    original = Sessions.required
    guards = 0
    with closing(sqlite3.connect(a.path)) as db:
        before = db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()

    async def advance(
        self: Sessions,
        db: AsyncSession,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session], None],
    ) -> Session:
        nonlocal guards
        current = await original(self, db, context, digest, authorize)
        guards += 1
        if guards == 2:
            a.clock[0] += timedelta(days=7)
        return current

    monkeypatch.setattr(Sessions, "required", advance)
    response = (
        await a.client.get("/api/v1/auth/me")
        if operation == "touch"
        else await a.client.post(
            "/api/v1/auth/logout",
            json={},
            headers={
                "X-CSRF-Token": a.auth.json()["csrf_token"],
                "X-Lexicona-Expected-Principal": "user:" + a.auth.json()["user"]["id"],
            },
        )
    )
    assert response.status_code == 401 and response.headers[STAMP] == "anonymous"
    assert "set-cookie" not in response.headers
    with closing(sqlite3.connect(a.path)) as db:
        assert (
            db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall() == before
        )

"""Final guards and revoke/redeem winners are decided under real IMMEDIATE WAL."""

import asyncio
import sqlite3
from contextlib import closing

import httpx
import pytest
from invite_helpers import (
    CREATE,
    REGISTER,
    Registration,
    admin_headers,
    registration,
    signed_in,
    snapshot,
)
from test_auth_native_lifecycle import NativeBarrier

from lexicona.auth.errors import Decision
from lexicona.auth.http import LoginPasswords
from lexicona.auth.rates import Reservation

__all__ = ["registration", "signed_in"]


async def test_revoke_commits_while_registration_hash_prepared_then_redeem_rejects(
    registration: Registration, monkeypatch: pytest.MonkeyPatch
) -> None:
    r = registration
    entered, release = asyncio.Event(), asyncio.Event()
    original = LoginPasswords.hash

    async def held(
        self: LoginPasswords, password: str, context: Decision, reservation: Reservation
    ) -> str:
        encoded = await original(self, password, context, reservation)
        entered.set()
        await release.wait()
        return encoded

    monkeypatch.setattr(LoginPasswords, "hash", held)
    task = asyncio.create_task(r.client.post(REGISTER, json=r.data, headers=r.headers))
    try:
        await asyncio.wait_for(entered.wait(), 3)
        revoked = await r.account.client.post(
            CREATE + "/" + r.id + "/revoke",
            json={"expected_version": 1},
            headers=admin_headers(r.account),
        )
        assert revoked.status_code == 200 and revoked.json()["state"] == "revoked"
        release.set()
        response = await task
        assert (
            response.status_code == 400
            and response.json()["error"]["code"] == "invite_invalid"
        )
        with closing(sqlite3.connect(r.account.path)) as db:
            assert db.execute(
                "SELECT count(*) FROM users WHERE role='user'"
            ).fetchone() == (0,)
            assert db.execute("SELECT used_at,version FROM invites").fetchone() == (
                None,
                2,
            )
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


async def test_redeem_submitted_commit_wins_revoke_waiting_for_writer(
    registration: Registration, monkeypatch: pytest.MonkeyPatch
) -> None:
    r = registration
    barrier = NativeBarrier("commit")
    barrier.install(monkeypatch)
    task = asyncio.create_task(r.client.post(REGISTER, json=r.data, headers=r.headers))
    revoke: asyncio.Task[httpx.Response] | None = None
    try:
        await asyncio.wait_for(barrier.entered.wait(), 3)
        before = len(barrier.connections)
        revoke = asyncio.create_task(
            r.account.client.post(
                CREATE + "/" + r.id + "/revoke",
                json={"expected_version": 1},
                headers=admin_headers(r.account),
            )
        )
        # The current reader can authorize, but the independent final writer
        # cannot pass BEGIN IMMEDIATE until registration's commit is released.
        from test_passwords import until

        await until(lambda: len(barrier.connections) > before)
        barrier.release.set()
        registered = await task
        revoked = await revoke
        assert registered.status_code == 201
        assert revoked.status_code == 409
        assert revoked.json()["error"]["code"] == "version_conflict"
        with closing(sqlite3.connect(r.account.path)) as db:
            assert db.execute(
                "SELECT count(*) FROM users WHERE role='user'"
            ).fetchone() == (1,)
            assert db.execute("SELECT revoked_at,version FROM invites").fetchone() == (
                None,
                2,
            )
    finally:
        barrier.release.set()
        await asyncio.gather(
            task, *([] if revoke is None else [revoke]), return_exceptions=True
        )


@pytest.mark.parametrize(
    "change", ["revoke-p", "csrf", "duplicate", "duplicate-invalid", "expire-p"]
)
async def test_register_final_guard_after_hash_discards_stale_admission(
    registration: Registration, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    from uuid import uuid4

    r = registration
    original = LoginPasswords.hash
    after: list[list[tuple[object, ...]]] = []

    async def changed(
        self: LoginPasswords, password: str, context: Decision, reservation: Reservation
    ) -> str:
        nonlocal after
        encoded = await original(self, password, context, reservation)
        with closing(sqlite3.connect(r.account.path)) as db:
            if change == "revoke-p":
                db.execute(
                    "UPDATE auth_sessions SET revoked_at=created_at "
                    "WHERE user_id IS NULL"
                )
            elif change == "csrf":
                from lexicona.auth.config import token

                db.execute(
                    "UPDATE auth_sessions SET csrf_token=? WHERE user_id IS NULL",
                    (token(),),
                )
            elif change == "expire-p":
                from datetime import timedelta

                r.account.clock[0] += timedelta(minutes=30)
            else:
                user = str(uuid4())
                db.execute(
                    "INSERT INTO users SELECT ?,?,display_name,password_hash,"
                    "'user',1,1,created_at,updated_at FROM users LIMIT 1",
                    (user, r.data["login"]),
                )
                db.execute(
                    "INSERT INTO user_settings SELECT ?,timezone,theme,daily_goal,"
                    "speech_rate,english_locale,version,created_at,updated_at "
                    "FROM user_settings LIMIT 1",
                    (user,),
                )
                if change == "duplicate-invalid":
                    db.execute("UPDATE invites SET revoked_at=created_at,version=2")
            db.commit()
        after = snapshot(r.account.path)
        return encoded

    monkeypatch.setattr(LoginPasswords, "hash", changed)
    response = await r.client.post(REGISTER, json=r.data, headers=r.headers)
    expected = {
        "revoke-p": (401, "auth_required"),
        "csrf": (403, "csrf_failed"),
        "duplicate": (409, "login_unavailable"),
        "duplicate-invalid": (400, "invite_invalid"),
        "expire-p": (401, "auth_required"),
    }
    assert (response.status_code, response.json()["error"]["code"]) == expected[change]
    assert "set-cookie" not in response.headers
    unchanged = snapshot(r.account.path) == after
    assert unchanged

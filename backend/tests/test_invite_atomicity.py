"""Atomic rollback, defensive CAS and expiry on independent file-WAL connections."""

import sqlite3
from contextlib import closing
from datetime import timedelta

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
from test_auth_http import COOKIE, STAMP

__all__ = ["registration", "signed_in"]


@pytest.mark.parametrize(
    "write", ["user", "settings", "consume", "pre-revoke", "session"]
)
async def test_register_fault_after_each_write_rolls_back_everything(
    registration: Registration, write: str
) -> None:
    r = registration
    clauses = {
        "user": "AFTER INSERT ON users",
        "settings": "AFTER INSERT ON user_settings",
        "consume": "AFTER UPDATE OF used_at ON invites",
        "pre-revoke": "AFTER UPDATE OF revoked_at ON auth_sessions",
        "session": "AFTER INSERT ON auth_sessions",
    }
    with closing(sqlite3.connect(r.account.path)) as db:
        db.execute(
            "CREATE TRIGGER fail_register "
            + clauses[write]
            + " BEGIN SELECT RAISE(ABORT,'private_driver_failure'); END"
        )
        db.commit()
    before = snapshot(r.account.path)
    cookie = r.client.cookies[COOKIE]
    result = await r.client.post(REGISTER, json=r.data, headers=r.headers)
    assert result.status_code == 503
    assert result.json()["error"]["code"] == "service_unavailable"
    assert (
        "private_driver_failure" not in result.text
        and "set-cookie" not in result.headers
    )
    unchanged = snapshot(r.account.path) == before
    assert unchanged and r.client.cookies[COOKIE] == cookie


@pytest.mark.parametrize("operation", ["consume", "revoke"])
async def test_conditional_update_no_row_fails_and_rolls_back(
    registration: Registration, operation: str
) -> None:
    r = registration
    with closing(sqlite3.connect(r.account.path)) as db:
        db.execute(
            "CREATE TRIGGER ignore_update BEFORE UPDATE OF "
            + ("used_at" if operation == "consume" else "revoked_at")
            + " ON invites BEGIN SELECT RAISE(IGNORE); END"
        )
        db.commit()
    before = snapshot(r.account.path)
    if operation == "consume":
        result = await r.client.post(REGISTER, json=r.data, headers=r.headers)
        assert (
            result.status_code == 400
            and result.json()["error"]["code"] == "invite_invalid"
        )
    else:
        result = await r.account.client.post(
            CREATE + "/" + r.id + "/revoke",
            json={"expected_version": 1},
            headers=admin_headers(r.account),
        )
        assert (
            result.status_code == 409
            and result.json()["error"]["code"] == "invite_state_conflict"
        )
    unchanged = snapshot(r.account.path) == before
    assert unchanged and "set-cookie" not in result.headers


@pytest.mark.parametrize(
    "state", ["unknown", "used", "revoked", "expired", "duplicate"]
)
async def test_invalid_invite_generic_and_valid_duplicate_does_not_consume(
    registration: Registration, state: str
) -> None:
    import secrets

    r = registration
    with closing(sqlite3.connect(r.account.path)) as db:
        if state == "used":
            db.execute("UPDATE invites SET used_at=created_at,version=2")
        elif state == "revoked":
            db.execute("UPDATE invites SET revoked_at=created_at,version=2")
        elif state == "expired":
            # Keep the current P valid while moving only fixture invite timestamps.
            db.execute(
                "UPDATE invites SET created_at=created_at-259200000000,"
                "expires_at=expires_at-259200000000"
            )
        db.commit()
    r.data["login"] = "admin"
    if state == "unknown":
        r.data["invite_token"] = secrets.token_urlsafe(32)
    before = snapshot(r.account.path)
    response = await r.client.post(REGISTER, json=r.data, headers=r.headers)
    expected = "login_unavailable" if state == "duplicate" else "invite_invalid"
    assert response.status_code == (409 if state == "duplicate" else 400)
    assert response.json()["error"]["code"] == expected
    assert response.json()["error"]["fields"] == (
        {"login": ["Логин недоступен."]} if state == "duplicate" else {}
    )
    unchanged = snapshot(r.account.path) == before
    assert unchanged and "set-cookie" not in response.headers


@pytest.mark.parametrize("delta", [-1, 0, 1])
async def test_invite_exact_72h_equality_and_no_secret_storage(
    registration: Registration, delta: int
) -> None:
    from lexicona.auth.config import token_hash
    from lexicona.auth.values import epoch_microseconds

    r = registration
    with closing(sqlite3.connect(r.account.path)) as db:
        created, expires, digest = db.execute(
            "SELECT created_at,expires_at,token_hash FROM invites"
        ).fetchone()
    assert expires - created == 259200000000
    assert isinstance(r.data["invite_token"], str)
    assert digest == token_hash(r.data["invite_token"]) and len(digest) == 32
    r.account.clock[0] += timedelta(hours=72, microseconds=delta)
    r.client.cookies.clear()
    csrf = await r.client.get("/api/v1/auth/csrf")
    r.headers["X-CSRF-Token"] = csrf.json()["csrf_token"]
    assert epoch_microseconds(r.account.clock[0]) == expires + delta
    response = await r.client.post(REGISTER, json=r.data, headers=r.headers)
    assert response.status_code == (201 if delta == -1 else 400)
    if delta == -1:
        assert response.json()["user"]["display_name"] == "Имя é"
        assert response.headers[STAMP] == "anonymous"
        me = await r.client.get("/api/v1/auth/me")
        assert me.json()["user"] == response.json()["user"]
        assert me.headers[STAMP] == "user:" + me.json()["user"]["id"]
    else:
        assert response.json()["error"]["code"] == "invite_invalid"
        assert "set-cookie" not in response.headers


@pytest.mark.parametrize("expire_after_rollback", [False, True])
async def test_real_unique_login_constraint_rollback_rechecks_invite_before_disclosure(
    registration: Registration,
    monkeypatch: pytest.MonkeyPatch,
    expire_after_rollback: bool,
) -> None:
    from uuid import uuid4

    from sqlalchemy.ext.asyncio import AsyncSession

    from lexicona.auth.invites import Invites

    r = registration
    duplicate_id = str(uuid4())
    with closing(sqlite3.connect(r.account.path)) as db:
        # A deterministic SQLite UNIQUE(login) conflict after the normal final
        # precheck. The statement and this trigger's row must both roll back.
        db.execute(
            "CREATE TRIGGER duplicate_login BEFORE INSERT ON users "
            "WHEN NEW.role='user' BEGIN INSERT INTO users "
            "SELECT '" + duplicate_id + "',NEW.login,NEW.display_name,"
            "NEW.password_hash,'user',1,1,NEW.created_at,NEW.updated_at; END"
        )
        db.commit()
    original = Invites.valid
    calls = 0

    async def valid(
        self: Invites, db: AsyncSession, digest: bytes, now: int
    ) -> tuple[str, int]:
        nonlocal calls
        calls += 1
        if expire_after_rollback and calls == 3:
            r.account.clock[0] += timedelta(hours=72)
            now = self.sessions.now()
        return await original(self, db, digest, now)

    monkeypatch.setattr(Invites, "valid", valid)
    before = snapshot(r.account.path)
    response = await r.client.post(REGISTER, json=r.data, headers=r.headers)
    assert response.status_code == (400 if expire_after_rollback else 409)
    assert response.json()["error"]["code"] == (
        "invite_invalid" if expire_after_rollback else "login_unavailable"
    )
    assert calls == 3 and "set-cookie" not in response.headers
    unchanged = snapshot(r.account.path) == before
    assert unchanged

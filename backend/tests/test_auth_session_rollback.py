"""Real rollback faults and admission-cap failures do not half-rotate sessions."""

import sqlite3
from contextlib import closing

import pytest
from test_auth_http import COOKIE, STAMP, SignedIn, signed_in
from test_login_rates_http import LOGIN, pre_auth
from test_login_rates_resources import Harness, harness

__all__ = ["signed_in", "harness"]


@pytest.mark.parametrize("write", ["revoke", "insert"])
async def test_logout_sql_fault_rolls_back_all_effects(
    signed_in: SignedIn, write: str
) -> None:
    a = signed_in
    with closing(sqlite3.connect(a.path)) as db:
        before = db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
        timing = "AFTER UPDATE OF revoked_at" if write == "revoke" else "AFTER INSERT"
        db.execute(
            "CREATE TRIGGER fail_rotation "
            + timing
            + (
                " ON auth_sessions BEGIN SELECT "
                "RAISE(ABORT,'synthetic_driver_canary'); END"
            )
        )
        db.commit()
    cookie = a.client.cookies[COOKIE]
    response = await a.client.post(
        "/api/v1/auth/logout",
        json={},
        headers={
            "X-CSRF-Token": a.auth.json()["csrf_token"],
            "X-Lexicona-Expected-Principal": "user:" + a.auth.json()["user"]["id"],
        },
    )
    assert (
        response.status_code == 503
        and response.json()["error"]["code"] == "service_unavailable"
    )
    assert "synthetic_driver_canary" not in response.text
    assert "set-cookie" not in response.headers and a.client.cookies[COOKIE] == cookie
    with closing(sqlite3.connect(a.path)) as db:
        assert (
            db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall() == before
        )


@pytest.mark.parametrize("write", ["revoke", "insert", "cap-revoke"])
async def test_login_sql_fault_rolls_back_all_effects(
    harness: Harness, write: str
) -> None:
    async with harness.client() as client:
        if write == "cap-revoke":
            for _ in range(5):
                client.cookies.clear()
                headers = await pre_auth(client)
                assert (
                    await client.post(
                        LOGIN,
                        json={"login": "admin", "password": harness.password},
                        headers=headers,
                    )
                ).status_code == 200
        client.cookies.clear()
        headers = await pre_auth(client)
        with closing(sqlite3.connect(harness.path)) as db:
            before = db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
            timing = (
                "AFTER INSERT" if write == "insert" else "AFTER UPDATE OF revoked_at"
            )
            condition = " WHEN OLD.user_id IS NOT NULL" if write == "cap-revoke" else ""
            db.execute(
                "CREATE TRIGGER fail_login "
                + timing
                + " ON auth_sessions"
                + condition
                + " BEGIN SELECT RAISE(ABORT,'synthetic_driver_canary'); END"
            )
            db.commit()
        response = await client.post(
            LOGIN,
            headers=headers,
            json={"login": "admin", "password": harness.password},
        )
        assert response.status_code == 503 and "set-cookie" not in response.headers
        with closing(sqlite3.connect(harness.path)) as db:
            assert (
                db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
                == before
            )


async def test_global_p_cap_rejects_logout_without_revoking_a(
    signed_in: SignedIn,
) -> None:
    from uuid import uuid4

    a = signed_in
    with closing(sqlite3.connect(a.path)) as db:
        created = db.execute(
            "SELECT created_at FROM auth_sessions WHERE user_id IS NOT NULL"
        ).fetchone()[0]
        db.executemany(
            "INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?)",
            [
                (
                    str(uuid4()),
                    None,
                    i.to_bytes(32, "big"),
                    "A" * 43,
                    created,
                    created,
                    created + 1800000000,
                    created + 1800000000,
                    None,
                )
                for i in range(10000)
            ],
        )
        db.commit()
        before = db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
    response = await a.client.post(
        "/api/v1/auth/logout",
        json={},
        headers={
            "X-CSRF-Token": a.auth.json()["csrf_token"],
            "X-Lexicona-Expected-Principal": "user:" + a.auth.json()["user"]["id"],
        },
    )
    assert response.status_code == 429 and "set-cookie" not in response.headers
    assert response.headers[STAMP] == "user:" + a.auth.json()["user"]["id"]
    with closing(sqlite3.connect(a.path)) as db:
        assert (
            db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall() == before
        )

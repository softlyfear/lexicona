"""New register/invite admissions retain the accepted native reservation model."""

import secrets

import pytest
from test_auth_http import SignedIn
from test_auth_http import signed_in as signed_in

from lexicona.auth.errors import AuthError
from lexicona.auth.rates import Rates


def test_register_dual_reservations_and_native_completion() -> None:
    now = [0.0]
    rates = Rates(lambda: now[0])
    slots = [rates.register("same", "127.0.0.1") for _ in range(5)]
    with pytest.raises(AuthError) as caught:
        rates.register("same", "127.0.0.2")
    assert caught.value.code == "rate_limited"
    assert caught.value.headers["Retry-After"] == "900"
    slots[0].start()
    slots[0].finish(success=True)
    with pytest.raises(AuthError):
        rates.register("same", "127.0.0.2")
    slots[0].completed()
    rates.register("same", "127.0.0.2").finish()
    for slot in slots[1:]:
        slot.finish()
    now[0] = 900
    rates.register("same", "127.0.0.1").finish()
    # Ten different token digests share the independent IP cap; no state reset.
    rates = Rates(lambda: now[0])
    for i in range(10):
        rates.register(str(i), "127.0.0.1").finish()
    with pytest.raises(AuthError) as caught:
        rates.register("new", "127.0.0.1")
    assert caught.value.headers["Retry-After"] == "900"


async def test_create_ten_per_admin_fixed_window(signed_in: SignedIn) -> None:
    account = signed_in
    headers = {
        "X-CSRF-Token": account.auth.json()["csrf_token"],
        "X-Lexicona-Expected-Principal": "user:" + account.auth.json()["user"]["id"],
    }
    for _ in range(10):
        response = await account.client.post(
            "/api/v1/admin/invites", json={}, headers=headers
        )
        assert response.status_code == 201
    blocked = await account.client.post(
        "/api/v1/admin/invites", json={}, headers=headers
    )
    assert blocked.status_code == 429
    assert 1 <= int(blocked.headers["retry-after"]) <= 60


async def test_registration_token_and_ip_limits(signed_in: SignedIn) -> None:
    account = signed_in
    await account.client.post(
        "/api/v1/auth/logout",
        json={},
        headers={
            "X-CSRF-Token": account.auth.json()["csrf_token"],
            "X-Lexicona-Expected-Principal": "user:"
            + account.auth.json()["user"]["id"],
        },
    )
    pre = await account.client.get("/api/v1/auth/csrf")
    headers = {
        "X-CSRF-Token": pre.json()["csrf_token"],
        "X-Lexicona-Expected-Principal": "anonymous",
    }
    data = {
        "login": "new_user",
        "display_name": "Имя",
        "password": secrets.token_urlsafe(24),
        "invite_token": secrets.token_urlsafe(32),
    }
    for _ in range(5):
        assert (
            await account.client.post(
                "/api/v1/auth/register", json=data, headers=headers
            )
        ).status_code == 400
    response = await account.client.post(
        "/api/v1/auth/register", json=data, headers=headers
    )
    assert response.status_code == 429
    assert 1 <= int(response.headers["retry-after"]) <= 900


async def test_active_global_cap_is_atomic(signed_in: SignedIn) -> None:
    import asyncio
    import sqlite3
    from contextlib import closing
    from uuid import uuid4

    account = signed_in
    headers = {
        "X-CSRF-Token": account.auth.json()["csrf_token"],
        "X-Lexicona-Expected-Principal": "user:" + account.auth.json()["user"]["id"],
    }
    created = await account.client.post(
        "/api/v1/admin/invites", json={}, headers=headers
    )
    assert created.status_code == 201
    with closing(sqlite3.connect(account.path)) as db:
        for i in range(98):
            db.execute(
                "INSERT INTO invites SELECT ?,?,created_by,created_at,expires_at,"
                "NULL,NULL,NULL,1 FROM invites LIMIT 1",
                (str(uuid4()), i.to_bytes(32, "big")),
            )
        db.commit()
        assert db.execute("SELECT count(*) FROM invites").fetchone() == (99,)
    results = await asyncio.gather(
        *(
            account.client.post("/api/v1/admin/invites", json={}, headers=headers)
            for _ in range(2)
        )
    )
    assert sorted(response.status_code for response in results) == [201, 429]
    blocked = next(response for response in results if response.status_code == 429)
    assert int(blocked.headers["retry-after"]) == 259200
    with closing(sqlite3.connect(account.path)) as db:
        assert db.execute("SELECT count(*) FROM invites").fetchone() == (100,)


def test_create_retry_after_is_max_of_admin_and_global_capacity() -> None:
    rates = Rates(lambda: 0.0)
    for _ in range(10):
        rates.creations.take("admin")
    with pytest.raises(AuthError) as caught:
        rates.create("admin", 1)
    assert caught.value.headers["Retry-After"] == "60"
    with pytest.raises(AuthError) as caught:
        rates.create("admin", 100)
    assert caught.value.headers["Retry-After"] == "100"
    rates.create("other-admin", None)


def test_new_maps_cardinality_and_total_bounded_cleanup() -> None:
    now = [0.0]
    rates = Rates(lambda: now[0])
    for i in range(10000):
        rates.general.take(str(i))
        rates.register(str(i), str(i)).finish()
    with pytest.raises(AuthError) as caught:
        rates.register("new", "new")
    assert caught.value.headers["Retry-After"] == "900"
    assert (
        len(rates.register_tokens.entries) == len(rates.register_ips.entries) == 10000
    )
    now[0] = 900
    before = sum(
        len(bucket.entries)
        for bucket in [rates.general, rates.register_tokens, rates.register_ips]
    )
    rates.general.take("new")
    rates.register("new", "new").finish()
    after = sum(
        len(bucket.entries)
        for bucket in [rates.general, rates.register_tokens, rates.register_ips]
    )
    assert 0 < before + 3 - after <= 128


def test_register_uses_later_blocking_axis_without_extending_windows() -> None:
    now = [0.0]
    rates = Rates(lambda: now[0])
    rates.register("token", "earlier-peer").finish()
    now[0] = 100
    for _ in range(4):
        rates.register("token", "peer").finish()
    for i in range(6):
        rates.register(str(i), "peer").finish()
    with pytest.raises(AuthError) as caught:
        rates.register("token", "peer")
    assert caught.value.headers["Retry-After"] == "900"
    now[0] = 110
    with pytest.raises(AuthError) as caught:
        rates.register("token", "peer")
    assert caught.value.headers["Retry-After"] == "890"


def test_create_capacity_retry_does_not_round_integer_window_twice() -> None:
    # Converting an already-ceiled wall-clock interval to an absolute float
    # monotonic deadline can add an ulp and make ceil return259201, not259200.
    rates = Rates(lambda: 1000000.001)
    with pytest.raises(AuthError) as caught:
        rates.create("admin", 259200)
    assert caught.value.headers["Retry-After"] == "259200"

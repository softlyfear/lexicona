"""Closed wire, current authorization, parser budgets and secret-free errors."""

import asyncio
import secrets
import sqlite3
from collections.abc import AsyncIterator
from contextlib import closing
from time import monotonic
from uuid import uuid1, uuid4

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

from lexicona.auth import boundary
from lexicona.auth.errors import Decision
from lexicona.auth.http import LoginPasswords

__all__ = ["registration", "signed_in"]


@pytest.mark.parametrize("operation", ["register", "create", "revoke"])
async def test_unsafe_guards_and_parser_matrix_no_effects(
    registration: Registration, operation: str, caplog: pytest.LogCaptureFixture
) -> None:
    r = registration
    client = r.client if operation == "register" else r.account.client
    route = (
        REGISTER
        if operation == "register"
        else CREATE
        if operation == "create"
        else CREATE + "/" + r.id + "/revoke"
    )
    headers = r.headers if operation == "register" else admin_headers(r.account)
    data: object = (
        r.data
        if operation == "register"
        else {}
        if operation == "create"
        else {"expected_version": 1}
    )
    before = snapshot(r.account.path)
    canary = secrets.token_urlsafe(24)
    for changes, expected in [
        ({"Origin": "null"}, 403),
        ({"Origin": "https://example.invalid"}, 403),
        ({"X-CSRF-Token": secrets.token_urlsafe(32)}, 403),
        ({"X-Lexicona-Expected-Principal": "invalid"}, 412),
    ]:
        result = await client.post(route, json=data, headers=headers | changes)
        assert result.status_code == expected
        assert "set-cookie" not in result.headers
    payloads: list[tuple[bytes, dict[str, str], int]] = [
        (b"{", {}, 400),
        (b"\xff", {}, 400),
        (b'{"x":1,"x":2}', {}, 400),
        (b'{"x":NaN}', {}, 400),
        (b"[" * 17 + b"0" + b"]" * 17, {}, 400),
        (b"{}", {"Content-Type": "text/plain"}, 415),
        (b"{}", {"Content-Encoding": "gzip"}, 415),
        (b" " * 16383 + b"{}", {"Content-Length": "2"}, 413),
        (('{"' + canary + '":"' + canary + '"}').encode(), {}, 422),
        (b"true", {}, 422),
    ]
    for payload, changes, expected in payloads:
        result = await client.post(
            route,
            content=payload,
            headers=headers | {"Content-Type": "application/json"} | changes,
        )
        assert result.status_code == expected
        assert result.headers["cache-control"] == "no-store"
        assert "set-cookie" not in result.headers
        assert canary not in result.text
        assert all(canary not in key + value for key, value in result.headers.items())
    unchanged = snapshot(r.account.path) == before
    assert unchanged and canary not in caplog.text


@pytest.mark.parametrize("state", ["pre", "user", "inactive"])
async def test_admin_reads_current_active_role_and_unsafe_order(
    registration: Registration, state: str
) -> None:
    r = registration
    client = r.client if state == "pre" else r.account.client
    with closing(sqlite3.connect(r.account.path)) as db:
        if state == "user":
            db.execute("UPDATE users SET role='user',version=version+1")
        elif state == "inactive":
            db.execute("UPDATE users SET is_active=0,version=version+1")
        db.commit()
    before = snapshot(r.account.path)
    response = await client.get(CREATE)
    assert response.status_code == (403 if state == "user" else 401)
    response = await client.post(
        CREATE,
        content=b"{",
        headers=admin_headers(r.account)
        | {
            "X-CSRF-Token": secrets.token_urlsafe(32),
            "Content-Type": "application/json",
        },
    )
    # For current non-admin A CSRF still precedes role; P/inactive fail401.
    assert response.status_code == (403 if state == "user" else 401)
    if state == "user":
        assert response.json()["error"]["code"] == "csrf_failed"
        response = await client.post(
            CREATE,
            json={},
            headers=admin_headers(r.account)
            | {"X-Lexicona-Expected-Principal": "anonymous"},
        )
        assert (
            response.status_code == 403
            and response.json()["error"]["code"] == "forbidden"
        )
    unchanged = snapshot(r.account.path) == before
    assert unchanged


async def test_register_strict_fields_and_malformed_token_never_hashes(
    registration: Registration, monkeypatch: pytest.MonkeyPatch
) -> None:
    r = registration
    calls = 0

    async def forbidden_hash(*args: object, **kwargs: object) -> str:
        nonlocal calls
        calls += 1
        raise AssertionError("hash dispatched for malformed input")

    monkeypatch.setattr(LoginPasswords, "hash", forbidden_hash)
    assert isinstance(r.data["invite_token"], str)
    for value in [r.data["invite_token"] + "=", "", "x", 1, False]:
        response = await r.client.post(
            REGISTER, json=r.data | {"invite_token": value}, headers=r.headers
        )
        assert response.status_code == 422
        assert set(response.json()["error"]["fields"]) == {"invite_token"}
    for key in ["owner", "user_id", "role", "is_active", "password_hash"]:
        response = await r.client.post(
            REGISTER, json=r.data | {key: "not-allowed"}, headers=r.headers
        )
        assert response.status_code == 422
        assert response.json()["error"]["fields"] == {
            "_request": ["Лишние поля запрещены."]
        }
    response = await r.client.post(
        REGISTER, json=r.data | {"display_name": []}, headers=r.headers
    )
    assert response.status_code == 422 and set(response.json()["error"]["fields"]) == {
        "display_name"
    }
    assert calls == 0


async def test_revoke_uuid_strict_versions_and_not_found(
    registration: Registration,
) -> None:
    r = registration
    headers = admin_headers(r.account)
    for id in [
        "invalid",
        r.id.upper(),
        r.id.replace("-", ""),
        "{" + r.id + "}",
        str(uuid1()),
    ]:
        result = await r.account.client.post(
            CREATE + "/" + id + "/revoke", json={"expected_version": 1}, headers=headers
        )
        assert result.status_code == 422
        assert result.json()["error"]["fields"] == {
            "invite_id": ["Недопустимый формат."]
        }
    route = CREATE + "/" + r.id + "/revoke"
    for value in [True, "1", 1.0, 0, -1, 9223372036854775808, None]:
        result = await r.account.client.post(
            route, json={"expected_version": value}, headers=headers
        )
        assert result.status_code == 422
        assert set(result.json()["error"]["fields"]) == {"expected_version"}
    result = await r.account.client.post(
        CREATE + "/" + str(uuid4()) + "/revoke",
        json={"expected_version": 1},
        headers=headers,
    )
    assert result.status_code == 404 and result.json()["error"]["code"] == "not_found"


@pytest.mark.parametrize("operation", ["register", "create", "revoke"])
async def test_new_routes_body_reader_uses_one_remaining_deadline(
    registration: Registration, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    r = registration
    client = r.client if operation == "register" else r.account.client
    route = (
        REGISTER
        if operation == "register"
        else CREATE
        if operation == "create"
        else CREATE + "/" + r.id + "/revoke"
    )
    headers = r.headers if operation == "register" else admin_headers(r.account)
    monkeypatch.setattr(
        boundary, "Decision", lambda deadline: Decision(monotonic() + 0.08)
    )
    before = snapshot(r.account.path)
    entered = asyncio.Event()
    hold = asyncio.Event()

    async def chunks() -> AsyncIterator[bytes]:
        yield b"{"
        entered.set()
        await hold.wait()
        yield b"}"

    task = asyncio.create_task(
        client.post(
            route,
            content=chunks(),
            headers=headers | {"Content-Type": "application/json"},
        )
    )
    await asyncio.wait_for(entered.wait(), 2)
    response = await asyncio.wait_for(task, 2)
    assert response.status_code == 408 and "set-cookie" not in response.headers
    unchanged = snapshot(r.account.path) == before
    assert unchanged


@pytest.mark.parametrize("operation", ["create", "revoke"])
@pytest.mark.parametrize("change", ["role", "active", "revoke", "csrf"])
async def test_admin_final_write_revalidates_after_preliminary_guard(
    registration: Registration,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
    change: str,
) -> None:
    from collections.abc import Callable

    from lexicona.auth.invites import Invites
    from lexicona.auth.sessions import Session, User

    r = registration
    original = Invites.check_admin
    after: list[list[tuple[object, ...]]] = []

    async def check(
        self: Invites,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session, User], None],
    ) -> None:
        nonlocal after
        await original(self, context, digest, authorize)
        with closing(sqlite3.connect(r.account.path)) as db:
            if change == "role":
                db.execute("UPDATE users SET role='user',version=version+1")
            elif change == "active":
                db.execute("UPDATE users SET is_active=0,version=version+1")
            elif change == "revoke":
                db.execute(
                    "UPDATE auth_sessions SET revoked_at=created_at "
                    "WHERE user_id IS NOT NULL"
                )
            else:
                db.execute(
                    "UPDATE auth_sessions SET csrf_token=? WHERE user_id IS NOT NULL",
                    (secrets.token_urlsafe(32),),
                )
            db.commit()
        after = snapshot(r.account.path)

    monkeypatch.setattr(Invites, "check_admin", check)
    route = CREATE if operation == "create" else CREATE + "/" + r.id + "/revoke"
    response = await r.account.client.post(
        route,
        json={} if operation == "create" else {"expected_version": 1},
        headers=admin_headers(r.account),
    )
    assert response.status_code == (403 if change in {"role", "csrf"} else 401)
    assert (
        response.json()["error"]["code"]
        == {
            "role": "forbidden",
            "active": "auth_required",
            "revoke": "auth_required",
            "csrf": "csrf_failed",
        }[change]
    )
    assert "set-cookie" not in response.headers
    unchanged = snapshot(r.account.path) == after
    assert unchanged


async def test_admin_list_touch_is_throttled_and_invalid_query_has_no_touch(
    registration: Registration,
) -> None:
    from datetime import timedelta

    r = registration

    def timing() -> tuple[int, int]:
        with closing(sqlite3.connect(r.account.path)) as db:
            row = db.execute(
                "SELECT last_seen_at,expires_at FROM auth_sessions "
                "WHERE user_id IS NOT NULL AND revoked_at IS NULL"
            ).fetchone()
            return int(row[0]), int(row[1])

    original = timing()
    r.account.clock[0] += timedelta(microseconds=299999999)
    assert (await r.account.client.get(CREATE)).status_code == 200
    assert timing() == original
    r.account.clock[0] += timedelta(microseconds=1)
    assert (await r.account.client.get(CREATE + "?limit=01")).status_code == 422
    assert timing() == original
    response = await r.account.client.get(CREATE)
    assert response.status_code == 200 and "set-cookie" not in response.headers
    assert timing() == (original[0] + 300000000, original[1] + 300000000)


async def test_admin_list_role_revalidation_precedes_due_touch(
    registration: Registration, monkeypatch: pytest.MonkeyPatch
) -> None:
    from collections.abc import Callable
    from datetime import timedelta

    from lexicona.auth.sessions import Session, Sessions, User

    r = registration
    r.account.clock[0] += timedelta(minutes=5)
    original = Sessions.touch
    called = 0
    after: list[list[tuple[object, ...]]] = []

    async def touch(
        self: Sessions,
        context: Decision,
        digest: bytes | None,
        authorize: Callable[[Session], None],
        *,
        user_check: Callable[[User], None] = lambda _: None,
    ) -> tuple[Session, User]:
        nonlocal called, after
        called += 1
        with closing(sqlite3.connect(r.account.path)) as db:
            db.execute("UPDATE users SET role='user',version=version+1")
            db.commit()
        after = snapshot(r.account.path)
        return await original(self, context, digest, authorize, user_check=user_check)

    monkeypatch.setattr(Sessions, "touch", touch)
    response = await r.account.client.get(CREATE)
    assert called == 1 and response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"
    unchanged = snapshot(r.account.path) == after
    assert unchanged and "set-cookie" not in response.headers


async def test_new_get_head_methods_never_receive_or_mutate(
    registration: Registration,
) -> None:
    import httpx
    from starlette.types import Message
    from test_auth_http import COOKIE

    r = registration
    transport = r.account.client._transport
    assert isinstance(transport, httpx.ASGITransport)
    before = snapshot(r.account.path)
    reads = 0

    async def receive() -> Message:
        nonlocal reads
        reads += 1
        raise AssertionError("GET/HEAD body read")

    for method, path, status in [
        ("GET", CREATE, 200),
        ("HEAD", CREATE, 405),
        ("GET", REGISTER, 405),
        ("HEAD", REGISTER, 405),
        ("GET", CREATE + "/" + r.id + "/revoke", 405),
        ("HEAD", CREATE + "/" + r.id + "/revoke", 405),
    ]:
        messages: list[Message] = []

        async def send(message: Message, target: list[Message] = messages) -> None:
            target.append(message)

        await transport.app(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": method,
                "scheme": "http",
                "path": path,
                "raw_path": path.encode(),
                "query_string": b"",
                "root_path": "",
                "server": ("127.0.0.1", 1234),
                "client": ("127.0.0.1", 1234),
                "headers": [
                    (
                        b"cookie",
                        (COOKIE + "=" + r.account.client.cookies[COOKIE]).encode(),
                    )
                ],
            },
            receive,
            send,
        )
        start = next(
            message for message in messages if message["type"] == "http.response.start"
        )
        assert start["status"] == status
        assert (b"cache-control", b"no-store") in start["headers"]
    unchanged = snapshot(r.account.path) == before
    assert reads == 0 and unchanged


async def test_register_requires_p_and_rejects_authenticated_before_body(
    registration: Registration,
) -> None:
    import httpx
    from test_auth_http import ORIGIN

    r = registration
    before = snapshot(r.account.path)
    result = await r.account.client.post(
        REGISTER,
        content=b"{",
        headers=admin_headers(r.account) | {"Content-Type": "application/json"},
    )
    assert (
        result.status_code == 409
        and result.json()["error"]["code"] == "already_authenticated"
    )
    async with httpx.AsyncClient(
        transport=r.client._transport, base_url=ORIGIN
    ) as missing:
        result = await missing.post(REGISTER, content=b"{")
        assert (
            result.status_code == 401
            and result.json()["error"]["code"] == "auth_required"
        )
    unchanged = snapshot(r.account.path) == before
    assert unchanged

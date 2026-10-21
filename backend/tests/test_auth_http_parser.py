"""Real byte-stream/parser limits and safe validation, without secret echo."""

import asyncio
import sqlite3
from collections.abc import AsyncIterator
from contextlib import closing
from pathlib import Path
from time import monotonic

import httpx
import pytest
from asgi_lifespan import LifespanManager
from starlette.types import Message
from test_auth_http import ORIGIN, STAMP, SignedIn, signed_in
from test_auth_schema import migrate

from lexicona.app import create_app
from lexicona.auth import boundary
from lexicona.auth.errors import Decision

__all__ = ["signed_in"]


async def test_logout_parser_matrix_no_effects(signed_in: SignedIn) -> None:
    a = signed_in
    headers = {
        "X-CSRF-Token": a.auth.json()["csrf_token"],
        "X-Lexicona-Expected-Principal": "user:" + a.auth.json()["user"]["id"],
        "Content-Type": "application/json",
    }
    cases: list[tuple[bytes, dict[str, str], int]] = [
        (b"", {}, 400),
        (b"{", {}, 400),
        (b"\xff", {}, 400),
        (b'{"nested":{"key":1,"key":2}}', {}, 400),
        (b'{"canary_key":NaN}', {}, 400),
        (b'{"canary_key":Infinity}', {}, 400),
        (b'{"canary_key":-Infinity}', {}, 400),
        (b"[" * 16 + b"0" + b"]" * 16, {}, 422),
        (b"[" * 17 + b"0" + b"]" * 17, {}, 400),
        (b'{"x":' + b"[" * 15 + b"0" + b"]" * 15 + b"}", {}, 422),
        (b'{"x":' + b"[" * 16 + b"0" + b"]" * 16 + b"}", {}, 400),
        (b"{}", {"Content-Type": "text/plain"}, 415),
        (b"{}", {"Content-Type": "application/json,application/json"}, 415),
        (b"{}", {"Content-Encoding": "gzip"}, 415),
        (b"{}", {"Content-Encoding": "identity,identity"}, 415),
        (b'"canary_value"', {}, 422),
        (b"null", {}, 422),
        (b"true", {}, 422),
        (b'{"canary_key":"canary_value","another_raw_key":42}', {}, 422),
        (b" " * 16383 + b"{}", {"Content-Length": "2"}, 413),
        (b'{"canary_key":"' + "я".encode() * 8192 + b'"}', {}, 413),
    ]
    with closing(sqlite3.connect(a.path)) as db:
        before = db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
    for payload, changes, status in cases:

        async def chunks(value: bytes = payload) -> AsyncIterator[bytes]:
            yield value[:100]
            yield value[100:]

        response = await a.client.post(
            "/api/v1/auth/logout", headers=headers | changes, content=chunks()
        )
        assert response.status_code == status
        assert "set-cookie" not in response.headers
        assert response.headers[STAMP] == headers["X-Lexicona-Expected-Principal"]
        assert "canary" not in response.text and "another_raw_key" not in response.text
        if status == 422:
            assert response.json()["error"]["fields"] == {
                "_request": [
                    "Лишние поля запрещены."
                    if payload.startswith(b"{")
                    else "Неверный тип."
                ]
            }
        with closing(sqlite3.connect(a.path)) as db:
            assert (
                db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
                == before
            )
    # Exact byte limit accepted, parameterized JSON media type and identity allowed.
    response = await a.client.post(
        "/api/v1/auth/logout",
        headers=headers
        | {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Encoding": "identity",
        },
        content=b" " * 16382 + b"{}",
    )
    assert response.status_code == 200


async def test_safe422_allowlist_and_message_order(tmp_path: Path) -> None:
    path = tmp_path / "validation.sqlite3"
    await asyncio.to_thread(migrate, path)
    app = create_app(f"sqlite+aiosqlite:///{path}")
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client,
    ):
        pre = await client.get("/api/v1/auth/csrf")
        headers = {
            "X-CSRF-Token": pre.json()["csrf_token"],
            "X-Lexicona-Expected-Principal": "anonymous",
        }
        cases: list[tuple[object, dict[str, list[str]]]] = [
            ({}, {"login": ["Обязательное поле."], "password": ["Обязательное поле."]}),
            (
                {"login": False, "password": []},
                {"login": ["Неверный тип."], "password": ["Неверный тип."]},
            ),
            (
                {"login": "no-hyphens", "password": "short"},
                {
                    "login": ["Недопустимое значение."],
                    "password": ["Недопустимое значение."],
                },
            ),
            (
                {
                    "login": "canary_login",
                    "password": "canary_password",
                    "raw_canary_key": 1,
                    "another_raw_canary_key": 2,
                },
                {"_request": ["Лишние поля запрещены."]},
            ),
        ]
        for payload, expected in cases:
            response = await client.post(
                "/api/v1/auth/login", headers=headers, json=payload
            )
            # httpx supplies media type; raw Pydantic errors never cross HTTP.
            assert response.status_code == 422
            assert response.json()["error"]["fields"] == expected
            assert "canary" not in response.text
            assert all(k not in response.text for k in ['"input"', '"ctx"', '"url"'])


async def test_read_deadline_uses_shared_admission(
    signed_in: SignedIn, monkeypatch: pytest.MonkeyPatch
) -> None:
    a = signed_in
    monkeypatch.setattr(
        boundary, "Decision", lambda deadline: Decision(monotonic() + 0.03)
    )
    entered = asyncio.Event()
    blocked = asyncio.Event()

    async def chunks() -> AsyncIterator[bytes]:
        yield b"{"
        entered.set()
        await blocked.wait()
        yield b"}"

    task = asyncio.create_task(
        a.client.post(
            "/api/v1/auth/logout",
            headers={
                "X-CSRF-Token": a.auth.json()["csrf_token"],
                "X-Lexicona-Expected-Principal": "user:" + a.auth.json()["user"]["id"],
                "Content-Type": "application/json",
            },
            content=chunks(),
        )
    )
    await asyncio.wait_for(entered.wait(), 1)
    response = await asyncio.wait_for(task, 1)
    assert response.status_code == 408 and "set-cookie" not in response.headers


@pytest.mark.parametrize("method", ["GET", "HEAD"])
async def test_get_head_never_read_body(tmp_path: Path, method: str) -> None:
    app = create_app(f"sqlite+aiosqlite:///{tmp_path / 'unused.sqlite3'}")
    reads = 0
    messages: list[Message] = []

    async def receive() -> Message:
        nonlocal reads
        reads += 1
        raise AssertionError("body read on GET/HEAD")

    async def send(message: Message) -> None:
        messages.append(message)

    for path in ["/api/v1/auth/me", "/api/v1/auth/csrf", "/api/v1/admin/unimplemented"]:
        await app(
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
                "client": ("192.0.2.1", 1234),
                "headers": [],
            },
            receive,
            send,
        )
    assert (
        reads == 0
        and len([m for m in messages if m["type"] == "http.response.start"]) == 3
    )

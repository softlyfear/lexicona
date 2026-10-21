"""Validation before login admission, including actual ASGI stream termination."""

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from time import monotonic

import httpx
import pytest
from asgi_lifespan import LifespanManager
from login_rate_helpers import LoginHasher
from starlette.types import Message
from test_auth_schema import migrate
from test_login_rates_http import LOGIN, ORIGIN, pre_auth
from test_login_rates_resources import Harness, harness

from lexicona.app import create_app
from lexicona.auth import boundary
from lexicona.auth.errors import AuthError, Decision
from lexicona.auth.http import LoginPasswords, valid_phc
from lexicona.auth.rates import Rates

__all__ = ["harness"]


@pytest.mark.parametrize(
    "payload,content_type,status",
    [
        (
            b'{"login":"admin","login":"admin","password":"synthetic-wrong"}',
            "application/json",
            400,
        ),
        (b'{"login":NaN}', "application/json", 400),
        (b"[" * 17 + b"0" + b"]" * 17, "application/json", 400),
        (b"{}", "text/plain", 415),
        (b" " * 16385, "application/json", 413),
        (
            b'{"login":"admin","password":"synthetic-wrong","extra1":1,"extra2":2}',
            "application/json",
            422,
        ),
    ],
    ids=["duplicate", "nonfinite", "nested", "media", "oversized", "extra-fields"],
)
async def test_invalid_input_precedes_login_admission(
    harness: Harness,
    payload: bytes,
    content_type: str,
    status: int,
) -> None:
    async with harness.client() as client:
        headers = await pre_auth(client)
        response = await client.post(
            LOGIN, headers=headers | {"Content-Type": content_type}, content=payload
        )
        assert response.status_code == status and harness.hasher.calls == 0
        assert "set-cookie" not in response.headers
        # Invalid input does not spend any of the five account/IP slots.
        for _ in range(5):
            assert (
                await client.post(
                    LOGIN,
                    headers=headers,
                    json={"login": "admin", "password": "synthetic-wrong"},
                )
            ).status_code == 401
        assert harness.hasher.calls == 5


async def test_stream_timeout_precedes_login_admission(
    harness: Harness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with harness.client() as client:
        headers = await pre_auth(client)
        monkeypatch.setattr(
            boundary, "Decision", lambda deadline: Decision(monotonic() + 0.03)
        )

        async def stream() -> AsyncIterator[bytes]:
            yield b"{"
            await asyncio.sleep(0.1)
            yield b"}"

        response = await client.post(
            LOGIN,
            headers=headers | {"Content-Type": "application/json"},
            content=stream(),
        )
        assert response.status_code == 408 and harness.hasher.calls == 0


async def test_actual_asgi_disconnect_before_body_does_not_hash(
    harness: Harness,
) -> None:
    async with harness.client() as client:
        headers = await pre_auth(client)
        cookie = client.cookies["lexicona_session_dev"]
        messages: list[Message] = []

        async def receive() -> Message:
            return {"type": "http.disconnect"}

        async def send(message: Message) -> None:
            messages.append(message)

        await harness.app(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "POST",
                "scheme": "http",
                "path": LOGIN,
                "raw_path": LOGIN.encode(),
                "query_string": b"",
                "root_path": "",
                "server": ("127.0.0.1", 5173),
                "client": ("192.0.2.1", 12345),
                "headers": [
                    (key.lower().encode(), value.encode())
                    for key, value in (
                        {
                            "Origin": ORIGIN,
                            "Cookie": "lexicona_session_dev=" + cookie,
                            "Content-Type": "application/json",
                        }
                        | headers
                    ).items()
                ],
            },
            receive,
            send,
        )
        assert messages[0]["status"] == 400 and harness.hasher.calls == 0


async def test_closed_passwords_and_unbounded_phc_are_safe() -> None:
    passwords = LoginPasswords()
    permit = Rates().login("account", "peer")
    try:
        with pytest.raises(AuthError) as error:
            await passwords.verify(
                None, "synthetic-wrong", Decision(monotonic() + 10), permit
            )
        assert error.value.code == "service_unavailable"
    finally:
        permit.finish()
        await passwords.close()
    assert not valid_phc("x" * 513)


async def test_native_backend_failure_is_not_invalid_credentials(
    tmp_path: Path,
) -> None:
    path = tmp_path / "backend.sqlite3"
    await asyncio.to_thread(migrate, path)
    hasher = LoginHasher()

    def fail() -> None:
        raise RuntimeError("synthetic resource failure")

    hasher.action = fail
    app = create_app(f"sqlite+aiosqlite:///{path}", password_hasher=hasher.typed())
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client,
    ):
        headers = await pre_auth(client)
        response = await client.post(
            LOGIN,
            headers=headers,
            json={"login": "missing", "password": "synthetic-wrong"},
        )
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "service_unavailable"
        assert hasher.calls == 1

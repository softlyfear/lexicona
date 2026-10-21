"""Slash rejections must not reflect queries or enter body/DB work."""

import asyncio
import json
import secrets
import socket
from contextlib import closing
from pathlib import Path
from uuid import UUID

import httpx
import pytest
import uvicorn
from starlette.types import Message

from lexicona.app import create_app


@pytest.mark.parametrize("method", ["GET", "POST", "HEAD", "OPTIONS"])
@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/auth/me/",
        "/api/v1/auth/login/",
        "/api/v1/auth/csrf/",
        "/api/v1/auth/logout/",
        "/api/v1/auth/",
        "/api/v1/admin/",
        "/api/v1/admin/invites/",
    ],
)
async def test_scoped_slash_rejects_without_body_or_database(
    tmp_path: Path, method: str, path: str
) -> None:
    database = tmp_path / "unused.sqlite3"
    app = create_app(f"sqlite+aiosqlite:///{database}")
    canary = secrets.token_hex(16).encode()
    messages: list[Message] = []
    reads = 0

    async def receive() -> Message:
        nonlocal reads
        reads += 1
        raise AssertionError("routing rejection read the body")

    async def send(message: Message) -> None:
        messages.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"password=" + canary,
            "root_path": "",
            "server": ("127.0.0.1", 1234),
            "client": ("192.0.2.1", 1234),
            "headers": [(b"content-type", b"application/json")],
        },
        receive,
        send,
    )
    start = next(m for m in messages if m["type"] == "http.response.start")
    headers = dict(start["headers"])
    body = b"".join(m.get("body", b"") for m in messages)
    assert start["status"] == 404
    assert start["status"] not in {301, 302, 307, 308}
    assert "location" not in {key.decode().lower() for key in headers}
    assert not any(canary in value for value in headers.values())
    assert canary not in body
    assert headers[b"cache-control"] == b"no-store"
    assert headers[b"x-lexicona-request-principal"] == b"anonymous"
    assert b"set-cookie" not in headers
    assert b"allow" not in headers
    error = json.loads(body)["error"]
    assert set(error) == {"code", "message", "fields", "request_id"}
    assert error["code"] == "not_found" and error["fields"] == {}
    assert error["request_id"].encode() == headers[b"x-request-id"]
    UUID(error["request_id"])
    assert reads == 0
    assert not database.exists()
    assert not await asyncio.to_thread(lambda: list(tmp_path.glob("unused.sqlite3*")))


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/v1/auth/me/"),
        ("POST", "/api/v1/auth/login/"),
        ("HEAD", "/api/v1/auth/csrf/"),
        ("OPTIONS", "/api/v1/auth/logout/"),
    ],
    ids=["get-slash", "post-slash", "head-slash", "options-slash"],
)
async def test_scoped_slash_rejects_over_real_uvicorn(
    tmp_path: Path, method: str, path: str
) -> None:
    canary = secrets.token_hex(16)
    database = tmp_path / "unused.sqlite3"
    app = create_app(f"sqlite+aiosqlite:///{database}")
    with closing(socket.socket()) as sock:
        sock.bind(("127.0.0.1", 0))
        assert sock.getsockname()[1] not in {8000, 5173}
        server = uvicorn.Server(
            uvicorn.Config(
                app,
                access_log=False,
                proxy_headers=False,
                log_config=None,
                log_level="warning",
                ws="none",
            )
        )
        serving = asyncio.create_task(server.serve(sockets=[sock]))
        try:
            async with asyncio.timeout(5):
                while not server.started:
                    assert not serving.done()
                    await asyncio.sleep(0.01)
            async with httpx.AsyncClient(
                base_url=f"http://127.0.0.1:{sock.getsockname()[1]}",
                follow_redirects=False,
            ) as client:
                response = await client.request(
                    method, path, params={"password": canary}
                )
            assert response.status_code == 404
            assert response.status_code not in {301, 302, 307, 308}
            assert "location" not in response.headers
            assert not any(canary in value for value in response.headers.values())
            assert canary.encode() not in response.content
            assert response.headers["cache-control"] == "no-store"
            assert response.headers["x-lexicona-request-principal"] == "anonymous"
            assert "set-cookie" not in response.headers
            if method == "HEAD":
                assert response.content == b""
            else:
                error = response.json()["error"]
                assert error["code"] == "not_found" and error["fields"] == {}
                assert error["request_id"] == response.headers["x-request-id"]
            assert not await asyncio.to_thread(
                lambda: list(tmp_path.glob("unused.sqlite3*"))
            )
        finally:
            server.should_exit = True
            await asyncio.wait_for(serving, 10)


async def test_legacy_health_slash_redirect_is_unchanged() -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app()),
        base_url="http://test",
        follow_redirects=False,
    ) as client:
        response = await client.get("/api/v1/health/live/", params={"probe": "legacy"})
        assert response.status_code == 307
        assert (
            response.headers["location"]
            == "http://test/api/v1/health/live?probe=legacy"
        )
        assert "x-lexicona-request-principal" not in response.headers
        canonical = await client.get("/api/v1/health/live")
        assert canonical.status_code == 200 and canonical.json() == {"status": "alive"}
        lookalike = await client.get("/api/v1/authentic/missing/")
        assert lookalike.status_code == 404
        assert lookalike.json() == {"detail": "Not Found"}
        assert "x-lexicona-request-principal" not in lookalike.headers

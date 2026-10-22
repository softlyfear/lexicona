"""Complete scoped 405 metadata without body reads or authorization effects."""

import asyncio
import json
import socket
from contextlib import closing
from pathlib import Path
from typing import Never
from uuid import UUID

import httpx
import pytest
import uvicorn
from fastapi import APIRouter, FastAPI, WebSocket
from starlette.types import Message, Receive, Scope, Send

import lexicona.app as app_module
from lexicona.app import create_app
from lexicona.auth.config import AuthConfig
from lexicona.auth.http import LoginPasswords
from lexicona.auth.invite_http import router as registered
from lexicona.auth.rates import Rates
from lexicona.auth.sessions import Sessions
from lexicona.database import Database

INVITES = "/api/v1/admin/invites"
WRONG_METHODS = ("OPTIONS", "PUT", "DELETE", "HEAD", "PATCH")
CONTROLS = (
    ("OPTIONS", "/api/v1/auth/csrf", 405, "GET"),
    ("HEAD", "/api/v1/auth/me", 405, "GET"),
    ("GET", "/api/v1/auth/login", 405, "POST"),
    ("OPTIONS", "/api/v1/auth/logout", 405, "POST"),
    ("HEAD", "/api/v1/auth/register", 405, "POST"),
    ("DELETE", INVITES + "/00000000-0000-4000-8000-000000000001/revoke", 405, "POST"),
    ("PATCH", "/api/v1/admin/unknown", 404, None),
    ("OPTIONS", INVITES + "/", 404, None),
    ("PUT", "/api/v1/auth/login/", 404, None),
)


@pytest.fixture(autouse=True)
def forbid_authorization_and_database(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: object, **kwargs: object) -> Never:
        raise AssertionError(
            "Routing rejection attempted authorization or database I/O"
        )

    monkeypatch.setattr(Sessions, "check", forbidden)
    monkeypatch.setattr(Database, "unit_of_work", forbidden)


async def raw_request(
    method: str, path: str, database: Path, app: FastAPI | None = None
) -> tuple[int, dict[str, str], bytes]:
    app = app if app is not None else create_app(f"sqlite+aiosqlite:///{database}")
    messages: list[Message] = []
    reads = 0

    async def receive() -> Message:
        nonlocal reads
        reads += 1
        raise AssertionError("Routing rejection read request body")

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
            "query_string": b"ignored=1",
            "root_path": "",
            "headers": [(b"allow", b"DELETE"), (b"x-request-id", b"untrusted")],
            "client": ("127.0.0.1", 42001),
            "server": ("127.0.0.1", 42002),
        },
        receive,
        send,
    )
    assert reads == 0 and not await asyncio.to_thread(database.exists)
    start = next(m for m in messages if m["type"] == "http.response.start")
    headers = {k.decode(): v.decode() for k, v in start["headers"]}
    body = b"".join(m.get("body", b"") for m in messages)
    return start["status"], headers, body


def scoped_error(
    status: int, headers: dict[str, str], body: bytes, expected_status: int
) -> None:
    assert status == expected_status
    assert headers["cache-control"] == "no-store"
    assert headers["x-lexicona-request-principal"] == "anonymous"
    request_id = UUID(headers["x-request-id"])
    assert request_id.version == 4 and str(request_id) == headers["x-request-id"]
    assert "set-cookie" not in headers and "location" not in headers
    error = json.loads(body)
    assert error == {
        "error": {
            "code": "method_not_allowed" if expected_status == 405 else "not_found",
            "message": (
                "Метод не поддерживается."
                if expected_status == 405
                else "Ресурс не найден."
            ),
            "fields": {},
            "request_id": str(request_id),
        }
    }


@pytest.mark.parametrize("method", WRONG_METHODS)
async def test_dual_method_allow_is_complete_without_receive(
    method: str, tmp_path: Path
) -> None:
    status, headers, body = await raw_request(method, INVITES, tmp_path / "absent.db")
    scoped_error(status, headers, body, 405)
    assert set(headers["allow"].split(", ")) == {"GET", "POST"}
    assert headers["allow"] == "GET, POST"


@pytest.mark.parametrize("method,path,expected_status,allow", CONTROLS)
async def test_single_method_and_not_found_controls_without_receive(
    method: str, path: str, expected_status: int, allow: str | None, tmp_path: Path
) -> None:
    status, headers, body = await raw_request(method, path, tmp_path / "absent.db")
    scoped_error(status, headers, body, expected_status)
    assert headers.get("allow") == allow


async def test_allow_uses_registered_metadata_and_ignores_websocket(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Extend the real router before factory registration, not the handler or matches.

    def extended(
        sessions: Sessions, config: AuthConfig, passwords: LoginPasswords, rates: Rates
    ) -> APIRouter:
        router = registered(sessions, config, passwords, rates)

        @router.api_route("/admin/metadata/{item}", methods=["PATCH", "GET"])
        async def metadata(item: str) -> dict[str, str]:
            return {"item": item}

        @router.websocket("/admin/metadata/{item}")
        async def websocket(socket: WebSocket) -> None:
            await socket.close()

        return router

    monkeypatch.setattr(app_module, "invite_router", extended)
    database = tmp_path / "absent.db"
    app = create_app(f"sqlite+aiosqlite:///{database}")
    status, headers, body = await raw_request(
        "OPTIONS", "/api/v1/admin/metadata/example", database, app
    )
    scoped_error(status, headers, body, 405)
    assert headers["allow"] == "GET, PATCH"


@pytest.mark.parametrize("method", ("HEAD", "OPTIONS", "PUT"))
async def test_legacy_health_405_stays_unscoped(method: str, tmp_path: Path) -> None:
    status, headers, body = await raw_request(
        method, "/api/v1/health/live", tmp_path / "absent.db"
    )
    assert status == 405 and headers["allow"] == "GET"
    assert json.loads(body) == {"detail": "Method Not Allowed"}
    assert (
        not {"x-request-id", "x-lexicona-request-principal", "cache-control"}
        & headers.keys()
    )


async def test_legacy_liveness_success_stays_unscoped(tmp_path: Path) -> None:
    status, headers, body = await raw_request(
        "GET", "/api/v1/health/live", tmp_path / "absent.db"
    )
    assert status == 200 and json.loads(body) == {"status": "alive"}
    assert headers["cache-control"] == "no-store"
    assert "x-request-id" not in headers and "allow" not in headers


async def test_real_uvicorn_routing_metadata_without_receive(tmp_path: Path) -> None:
    database = tmp_path / "absent.db"
    app = create_app(f"sqlite+aiosqlite:///{database}")
    reads = 0

    async def measured(scope: Scope, receive: Receive, send: Send) -> None:
        async def counted() -> Message:
            nonlocal reads
            reads += 1
            return await receive()

        await app(scope, counted, send)

    with closing(socket.socket()) as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        assert port not in {8000, 5173, 34199}
        origin = f"http://127.0.0.1:{port}"
        server = uvicorn.Server(
            uvicorn.Config(
                measured,
                host="127.0.0.1",
                port=port,
                access_log=False,
                proxy_headers=False,
                lifespan="off",
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
            async with httpx.AsyncClient(base_url=origin) as client:
                cases = [
                    (method, INVITES, 405, "GET, POST") for method in WRONG_METHODS
                ]
                for method, path, expected_status, allow in [*cases, *CONTROLS]:
                    response = await client.request(
                        method,
                        path,
                        content=b"{",
                        headers={"Allow": "DELETE", "X-Request-ID": "untrusted"},
                    )
                    assert reads == 0 and not await asyncio.to_thread(database.exists)
                    assert response.status_code == expected_status
                    assert response.headers.get("allow") == allow
                    assert response.headers["cache-control"] == "no-store"
                    assert (
                        response.headers["x-lexicona-request-principal"] == "anonymous"
                    )
                    assert UUID(response.headers["x-request-id"]).version == 4
                    assert "set-cookie" not in response.headers
                    assert "location" not in response.headers
                    if method == "HEAD":
                        assert response.content == b""
                    else:
                        scoped_error(
                            response.status_code,
                            dict(response.headers),
                            response.content,
                            expected_status,
                        )
                legacy = await client.put("/api/v1/health/live", content=b"{")
                assert legacy.status_code == 405 and legacy.headers["allow"] == "GET"
                assert legacy.json() == {"detail": "Method Not Allowed"}
                assert "x-request-id" not in legacy.headers
                live = await client.get("/api/v1/health/live")
                assert live.status_code == 200 and live.json() == {"status": "alive"}
                assert reads == 0 and not await asyncio.to_thread(database.exists)
        finally:
            server.should_exit = True
            await asyncio.wait_for(serving, 10)

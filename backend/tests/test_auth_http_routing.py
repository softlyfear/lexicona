"""Framework rejects use the same closed error policy in auth/admin scope."""

import httpx
import pytest
from test_auth_http import STAMP

from lexicona.app import create_app


@pytest.mark.parametrize(
    ("method", "path", "status", "allow"),
    [
        ("GET", "/api/v1/auth/missing", 404, None),
        ("GET", "/api/v1/admin/invites", 404, None),
        ("POST", "/api/v1/auth/me", 405, "GET"),
        ("OPTIONS", "/api/v1/auth/logout", 405, "POST"),
        ("HEAD", "/api/v1/auth/csrf", 405, "GET"),
        ("PUT", "/api/v1/admin/missing", 404, None),
    ],
)
async def test_scoped_routing_errors(
    method: str, path: str, status: int, allow: str | None
) -> None:
    app = create_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.request(method, path)
    assert response.status_code == status
    assert response.headers[STAMP] == "anonymous"
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers
    assert response.headers.get("allow") == allow
    if method == "HEAD":
        assert response.content == b""
    else:
        error = response.json()["error"]
        assert set(error) == {"code", "message", "fields", "request_id"}
        assert error["code"] == ("not_found" if status == 404 else "method_not_allowed")
        assert error["fields"] == {}
        assert error["request_id"] == response.headers["x-request-id"]


async def test_unscoped_legacy_routing_is_unchanged() -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app()), base_url="http://test"
    ) as client:
        response = await client.get("/api/v1/authentic/missing")
    assert response.status_code == 404 and response.json() == {"detail": "Not Found"}
    assert STAMP not in response.headers

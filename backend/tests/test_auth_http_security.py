"""Strict guards at the actual HTTP boundary, with exact no-effect checks."""

import asyncio
import sqlite3
from contextlib import closing
from pathlib import Path
from uuid import uuid4

import httpx
from asgi_lifespan import LifespanManager
from test_auth_http import COOKIE, ORIGIN, STAMP, SignedIn, signed_in
from test_auth_schema import migrate

from lexicona.app import create_app
from lexicona.auth.config import AuthConfig, token

__all__ = ["signed_in"]


async def test_unsafe_guard_matrix_has_no_db_effect(signed_in: SignedIn) -> None:
    a = signed_in
    marker = "user:" + a.auth.json()["user"]["id"]
    csrf = a.auth.json()["csrf_token"]
    cookie = a.client.cookies[COOKIE]
    baseline = [
        ("Origin", ORIGIN),
        ("Cookie", COOKIE + "=" + cookie),
        ("X-CSRF-Token", csrf),
        ("X-Lexicona-Expected-Principal", marker),
        ("Content-Type", "application/json"),
    ]
    cases: list[tuple[str, list[str], int]] = [
        ("Origin", [], 403),
        ("Origin", ["null"], 403),
        ("Origin", [ORIGIN + "/"], 403),
        ("Origin", ["http://evil.127.0.0.1:5173"], 403),
        ("Origin", ["http://127.0.0.1:5174"], 403),
        ("Origin", ["https://127.0.0.1:5173"], 403),
        ("Origin", [ORIGIN, ORIGIN], 403),
        ("Origin", [ORIGIN + "," + ORIGIN], 403),
        ("Origin", ["x" * 9000], 403),
        ("X-CSRF-Token", [], 403),
        ("X-CSRF-Token", [token()], 403),
        ("X-CSRF-Token", [csrf, csrf], 403),
        ("X-CSRF-Token", [csrf + "," + csrf], 403),
        ("X-CSRF-Token", [csrf + "="], 403),
        ("X-CSRF-Token", ["A" * 9000], 403),
        ("X-Lexicona-Expected-Principal", [], 412),
        ("X-Lexicona-Expected-Principal", ["anonymous"], 412),
        ("X-Lexicona-Expected-Principal", ["user:" + str(uuid4())], 412),
        ("X-Lexicona-Expected-Principal", [marker, marker], 412),
        ("X-Lexicona-Expected-Principal", [marker + "," + marker], 412),
        ("X-Lexicona-Expected-Principal", [marker.upper()], 412),
        ("X-Lexicona-Expected-Principal", [" " + marker], 412),
        (
            "X-Lexicona-Expected-Principal",
            ["user:00000000-0000-1000-8000-000000000000"],
            412,
        ),
        ("X-Lexicona-Expected-Principal", ["x" * 9000], 412),
        ("Cookie", [], 401),
        ("Cookie", [COOKIE + "=" + token()], 401),
        ("Cookie", [COOKIE + "=" + cookie + "; " + COOKIE + "=" + cookie], 401),
        ("Cookie", [COOKIE + "=" + cookie, COOKIE + "=" + cookie], 401),
        ("Cookie", [COOKIE + "=" + cookie + "="], 401),
        ("Cookie", [COOKIE + "=" + "A" * 9000], 431),
        ("Cookie", ["other=" + cookie], 401),
    ]
    with closing(sqlite3.connect(a.path)) as db:
        before = db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
    for name, values, status in cases:
        headers = [h for h in baseline if h[0] != name] + [(name, v) for v in values]
        request = a.client.build_request(
            "POST", "/api/v1/auth/logout", content=b"not-json"
        )
        request.headers = httpx.Headers(headers)
        response = await a.client.send(request)
        assert response.status_code == status
        assert response.headers[STAMP] == (
            "anonymous" if status in {401, 431} else marker
        )
        assert response.headers["cache-control"] == "no-store"
        assert "set-cookie" not in response.headers
        with closing(sqlite3.connect(a.path)) as db:
            assert (
                db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
                == before
            )


async def test_referer_fallback_and_authoritative_origin(tmp_path: Path) -> None:
    path = tmp_path / "referer.sqlite3"
    await asyncio.to_thread(migrate, path)
    origin = "https://auth.example.test"
    config = AuthConfig(origin, development=False)
    app = create_app(f"sqlite+aiosqlite:///{path}", auth_config=config)
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=origin
        ) as client,
    ):
        denied: list[list[tuple[str, str]]] = [
            [],
            [("Referer", "http://auth.example.test/path")],
            [("Referer", origin + ".evil/path")],
            [("Referer", "https://user:pass@auth.example.test/path")],
            [("Referer", origin + "/path#fragment")],
            [("Referer", "https://[invalid")],
            [("Referer", origin + ":bad/path")],
            [("Referer", origin), ("Referer", origin)],
            [("Origin", "null"), ("Referer", origin + "/path")],
            [("Sec-Fetch-Site", "same-site"), ("Referer", origin)],
            [("Sec-Fetch-Site", "none"), ("Referer", origin)],
        ]
        for headers in denied:
            response = await client.get("/api/v1/auth/csrf", headers=headers)
            assert response.status_code == 403 and "set-cookie" not in response.headers
        for allowed_headers in [
            {"Sec-Fetch-Site": "same-origin"},
            {"Referer": origin + "/path?q=ok"},
            {"Origin": origin, "Referer": "https://evil.invalid"},
        ]:
            response = await client.get("/api/v1/auth/csrf", headers=allowed_headers)
            assert response.status_code == 200
        csrf = response.json()["csrf_token"]
        response = await client.post(
            "/api/v1/auth/logout",
            json={},
            headers={
                "Referer": origin + "/path",
                "X-CSRF-Token": csrf,
                "X-Lexicona-Expected-Principal": "anonymous",
            },
        )
        assert response.status_code == 200
        cookie = response.headers["set-cookie"]
        assert cookie.startswith("__Host-lexicona_session=")
        assert all(
            flag in cookie
            for flag in ["Secure", "HttpOnly", "Path=/", "SameSite=lax", "Max-Age=1800"]
        )
        assert "Domain" not in cookie
        # Dev cookies cannot authenticate the production instance.
        response = await client.get(
            "/api/v1/auth/me", headers={"Cookie": "lexicona_session_dev=" + token()}
        )
        assert response.status_code == 401 and response.headers[STAMP] == "anonymous"

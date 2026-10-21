"""Login admission through actual HTTP, cookies and migrated file-backed WAL."""

import asyncio
from pathlib import Path

import httpx
from asgi_lifespan import LifespanManager
from login_rate_helpers import LoginHasher, RateClock
from test_auth_schema import migrate

from lexicona.app import create_app

ORIGIN = "http://127.0.0.1:5173"
LOGIN = "/api/v1/auth/login"


async def pre_auth(client: httpx.AsyncClient) -> dict[str, str]:
    response = await client.get("/api/v1/auth/csrf")
    assert response.status_code == 200
    return {
        "X-CSRF-Token": response.json()["csrf_token"],
        "X-Lexicona-Expected-Principal": "anonymous",
    }


async def test_sixth_failure_blocked_before_password_work(tmp_path: Path) -> None:
    path = tmp_path / "login.sqlite3"
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
        headers = await pre_auth(client)
        for _ in range(5):
            response = await client.post(
                LOGIN,
                json={"login": "MISSING", "password": "synthetic-wrong"},
                headers=headers,
            )
            assert response.status_code == 401
        response = await client.post(
            LOGIN,
            json={"login": "missing", "password": "synthetic-wrong"},
            headers=headers,
        )
        assert response.status_code == 429
        assert response.json()["error"]["code"] == "rate_limited"
        assert 1 <= int(response.headers["retry-after"]) <= 900
        assert "set-cookie" not in response.headers


async def test_simultaneous_http_cannot_bypass_five_reservations(
    tmp_path: Path,
) -> None:
    path = tmp_path / "burst.sqlite3"
    await asyncio.to_thread(migrate, path)
    hasher = LoginHasher()
    clock = RateClock()
    app = create_app(
        f"sqlite+aiosqlite:///{path}",
        password_hasher=hasher.typed(),
        rate_clock=clock,
    )
    tasks: list[asyncio.Task[httpx.Response]] = []
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client,
    ):
        headers = await pre_auth(client)
        hasher.hold = True
        try:
            tasks = [
                asyncio.create_task(
                    client.post(
                        LOGIN,
                        json={"login": "missing", "password": "synthetic-wrong"},
                        headers=headers,
                    )
                )
                for _ in range(6)
            ]
            await hasher.wait_started()
            await hasher.wait_started()
            done, _ = await asyncio.wait(
                tasks, timeout=0.5, return_when=asyncio.FIRST_COMPLETED
            )
            assert len(done) == 1 and next(iter(done)).result().status_code == 429
            assert hasher.calls == 2
            hasher.release.set()
            responses = await asyncio.gather(*tasks)
            assert sorted(r.status_code for r in responses) == [401] * 5 + [429]
            assert hasher.calls == 5
        finally:
            hasher.release.set()
            await asyncio.gather(*tasks, return_exceptions=True)

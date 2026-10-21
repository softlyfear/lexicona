"""Real Uvicorn socket peer cannot be overwritten by forged proxy headers."""

import asyncio
import os
import secrets
import signal
import socket
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

import httpx
import pytest
from test_auth_schema import migrate
from test_login_rates_http import LOGIN, pre_auth

from lexicona.operations.admin import main


async def test_real_server_forged_proxy_cannot_bypass_ip_or_origin(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    path = tmp_path / "socket.sqlite3"
    await asyncio.to_thread(migrate, path)
    url = f"sqlite+aiosqlite:///{path}"
    monkeypatch.setenv("LEXICONA_DATABASE_URL", url)
    secret = secrets.token_urlsafe(24)
    assert (
        await asyncio.to_thread(
            main,
            ["bootstrap", "--login", "admin", "--display-name", "Synthetic"],
            prompt=lambda: secret,
        )
        == 0
    )
    assert capsys.readouterr().out == "Первый администратор создан.\n"
    with closing(socket.socket()) as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    assert port not in {8000, 5173}
    origin = f"http://127.0.0.1:{port}"
    env = dict(os.environ)
    for name in ("PYTHONPATH", "PYTHONHOME"):
        env.pop(name, None)
    env["LEXICONA_TEST_ORIGIN"] = origin
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "uvicorn",
        "login_rate_server:factory",
        "--factory",
        "--app-dir",
        "tests",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--workers",
        "1",
        "--no-proxy-headers",
        "--no-access-log",
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with httpx.AsyncClient(
            base_url=origin, headers={"Origin": origin}
        ) as client:
            ready = False
            for _ in range(100):
                assert process.returncode is None
                try:
                    ready = (
                        await client.get("/api/v1/health/ready")
                    ).status_code == 200
                except httpx.ConnectError:
                    pass
                if ready:
                    break
                await asyncio.sleep(0.05)
            assert ready
            forged = {"X-Forwarded-For": "198.51.100.9", "X-Forwarded-Proto": "https"}
            response = await client.get(
                "/api/v1/auth/csrf",
                headers=forged | {"Origin": origin.replace("http:", "https:")},
            )
            assert response.status_code == 403
            headers = await pre_auth(client)
            for n in range(6):
                response = await client.post(
                    LOGIN,
                    headers=headers
                    | {
                        "X-Forwarded-For": f"198.51.100.{n + 1}",
                        "X-Forwarded-Proto": "https",
                        "X-Forwarded-Host": "evil.invalid",
                    },
                    json={"login": f"missing_{n}", "password": "synthetic-wrong"},
                )
                assert response.status_code == (401 if n < 5 else 429)
                assert response.headers["cache-control"] == "no-store"
                assert "set-cookie" not in response.headers
            assert 1 <= int(response.headers["retry-after"]) <= 900
    finally:
        process.terminate()
        stdout, stderr = await asyncio.wait_for(process.communicate(), 10)
        assert process.returncode in {0, -signal.SIGTERM}
        output = (stdout + stderr).decode()
        assert "Application shutdown complete." in output
        assert secret not in output and "synthetic-wrong" not in output
        assert "$argon2" not in output and "missing_" not in output
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone() == ("wal",)
        assert connection.execute(
            "SELECT count(*) FROM auth_sessions WHERE user_id IS NOT NULL"
        ).fetchone() == (0,)

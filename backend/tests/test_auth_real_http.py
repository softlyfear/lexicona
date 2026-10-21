"""Real HTTP/Argon2 heartbeat, independent WAL writer, and protocol redaction."""

import asyncio
import logging
import math
import resource
import secrets
import socket
import sqlite3
import threading
from contextlib import closing
from pathlib import Path
from time import monotonic

import httpx
import pytest
import uvicorn
from sqlalchemy.ext.asyncio import AsyncSession
from test_auth_schema import migrate
from test_login_rates_http import LOGIN, pre_auth

from lexicona.app import create_app
from lexicona.auth.config import AuthConfig
from lexicona.auth.passwords import ArgonHasher, Hasher
from lexicona.auth.sessions import Sessions, User
from lexicona.operations.admin import main


class MeasuredArgon:
    """Barriers surround real production-profile verification, never a fake hash."""

    def __init__(self) -> None:
        self.inner = ArgonHasher()
        self.lock = threading.Lock()
        self.both_started = threading.Event()
        self.release = threading.Event()
        self.running = 0
        self.peak = 0
        self.calls = 0
        self.native_seconds: list[float] = []

    def verify(self, encoded: str, password: str) -> bool:
        with self.lock:
            self.running += 1
            self.calls += 1
            number = self.calls
            self.peak = max(self.peak, self.running)
            if self.running == 2:
                self.both_started.set()
        try:
            if number <= 2 and not self.release.wait(5):
                raise RuntimeError("Synthetic barrier deadline")
            started = monotonic()
            result = self.inner.verify(encoded, password)
            with self.lock:
                self.native_seconds.append(monotonic() - started)
            return result
        finally:
            with self.lock:
                self.running -= 1


def p95(values: list[float]) -> float:
    return sorted(values)[math.ceil(len(values) * 0.95) - 1] * 1000


async def test_real_http_argon_heartbeat_writer_and_protocol_redaction(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    path = tmp_path / "real-argon.sqlite3"
    await asyncio.to_thread(migrate, path)
    url = f"sqlite+aiosqlite:///{path}"
    monkeypatch.setenv("LEXICONA_DATABASE_URL", url)
    password = secrets.token_urlsafe(24)
    assert (
        await asyncio.to_thread(
            main,
            ["bootstrap", "--login", "admin", "--display-name", "Synthetic"],
            prompt=lambda: password,
        )
        == 0
    )
    assert capsys.readouterr().out == "Первый администратор создан.\n"
    caplog.set_level(logging.INFO, logger="lexicona.http")
    caplog.set_level(logging.DEBUG, logger="aiosqlite")
    caplog.set_level(logging.DEBUG, logger="sqlalchemy.engine")
    with closing(socket.socket()) as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        assert port not in {8000, 5173}
        origin = f"http://127.0.0.1:{port}"
        hasher = MeasuredArgon()
        app = create_app(
            url,
            auth_config=AuthConfig(origin),
            password_hasher=Hasher(hasher.inner.hash, hasher.verify),
        )
        server = uvicorn.Server(
            uvicorn.Config(
                app,
                host="127.0.0.1",
                port=port,
                access_log=False,
                proxy_headers=False,
                log_config=None,
                log_level="warning",
                ws="none",
            )
        )
        serving = asyncio.create_task(server.serve(sockets=[sock]))
        clients: list[httpx.AsyncClient] = []
        tasks: list[asyncio.Task[httpx.Response]] = []
        stop = asyncio.Event()
        gaps: list[float] = []
        health_seconds: list[float] = []
        login_seconds: list[float] = []
        canaries: list[str] = [password]

        async def heartbeat() -> None:
            previous = monotonic()
            while not stop.is_set():
                await asyncio.sleep(0.01)
                current = monotonic()
                gaps.append(current - previous)
                previous = current

        async def login(
            client: httpx.AsyncClient, headers: dict[str, str]
        ) -> httpx.Response:
            started = monotonic()
            response = await client.post(
                LOGIN, headers=headers, json={"login": "admin", "password": password}
            )
            login_seconds.append(monotonic() - started)
            return response

        pulse: asyncio.Task[None] | None = None
        try:
            async with asyncio.timeout(5):
                while not server.started:
                    assert not serving.done()
                    await asyncio.sleep(0.01)
            for _ in range(5):
                client = httpx.AsyncClient(base_url=origin, headers={"Origin": origin})
                clients.append(client)
            headers = [await pre_auth(c) for c in clients]
            canaries += [c.cookies["lexicona_session_dev"] for c in clients]
            canaries += [h["X-CSRF-Token"] for h in headers]
            pulse = asyncio.create_task(heartbeat())
            tasks = [
                asyncio.create_task(login(c, h))
                for c, h in zip(clients, headers, strict=True)
            ]
            assert await asyncio.to_thread(hasher.both_started.wait, 3)

            def competing_writer() -> None:
                with closing(sqlite3.connect(path, timeout=0.5)) as db:
                    db.execute("BEGIN IMMEDIATE")
                    db.execute("UPDATE users SET display_name=display_name")
                    db.commit()

            started = monotonic()
            await asyncio.wait_for(asyncio.to_thread(competing_writer), 1)
            writer_ms = (monotonic() - started) * 1000
            # The writer commits while both native verify invocations own their
            # hash permits. They have not returned and no auth write may exist.
            with closing(sqlite3.connect(path)) as db:
                assert db.execute(
                    "SELECT count(*) FROM auth_sessions WHERE user_id IS NOT NULL"
                ).fetchone() == (0,)
            hasher.release.set()
            while not all(task.done() for task in tasks):
                started = monotonic()
                response = await clients[0].get("/api/v1/health/live")
                health_seconds.append(monotonic() - started)
                assert response.status_code == 200 and response.json() == {
                    "status": "alive"
                }
                await asyncio.sleep(0.01)
            responses = await asyncio.gather(*tasks)
            assert all(r.status_code == 200 for r in responses)
            assert hasher.calls == 5 and hasher.peak == 2
            assert len(hasher.native_seconds) == 5 and min(hasher.native_seconds) > 0
            for client in clients:
                response = await client.get("/api/v1/auth/me")
                assert response.status_code == 200
                assert (
                    response.headers["X-Lexicona-Request-Principal"]
                    == "user:" + response.json()["user"]["id"]
                )
            for response in responses:
                canaries.append(response.json()["csrf_token"])

            canary = "probe_" + secrets.token_hex(16)
            canaries.append(canary)
            # These are actual HTTP application errors, not mocked responses.
            requests: list[tuple[str, str, bytes, dict[str, str]]] = [
                ("GET", "/api/v1/auth/" + canary, b"", {}),
                ("GET", "/api/v1/auth/me?" + canary + "=" + canary, b"", {}),
                (
                    "POST",
                    "/api/v1/auth/logout",
                    ('{"' + canary + '":"' + canary + '"}').encode(),
                    {},
                ),
                ("POST", "/api/v1/auth/logout", b'{"' + canary.encode() + b'":', {}),
            ]
            auth = responses[0]
            safe_headers = {
                "X-CSRF-Token": auth.json()["csrf_token"],
                "X-Lexicona-Expected-Principal": "user:" + auth.json()["user"]["id"],
                "Content-Type": "application/json",
            }
            for method, route, payload, extra in requests:
                response = await clients[0].request(
                    method, route, content=payload, headers=safe_headers | extra
                )
                assert response.status_code in {400, 404, 422}
                assert response.headers["cache-control"] == "no-store"
                assert (
                    "x-request-id" in response.headers
                    and "set-cookie" not in response.headers
                )
                assert all(c not in response.text for c in canaries)

            async def fail_user(self: Sessions, db: AsyncSession, id: str) -> User:
                raise RuntimeError(canary)

            with monkeypatch.context() as fault:
                fault.setattr(Sessions, "by_id", fail_user)
                response = await clients[0].get("/api/v1/auth/me")
                assert response.status_code == 500
                assert response.json()["error"]["code"] == "internal_error"
                assert all(c not in response.text for c in canaries)
                assert "set-cookie" not in response.headers
            with closing(sqlite3.connect(path)) as db:
                before = db.execute(
                    "SELECT * FROM auth_sessions ORDER BY id"
                ).fetchall()
                canaries.append(
                    db.execute("SELECT password_hash FROM users").fetchone()[0]
                )
                # The generated hexadecimal suffix has no SQL metacharacters.
                db.execute(
                    (
                        "CREATE TRIGGER fail_logout AFTER INSERT ON auth_sessions "
                        "BEGIN SELECT RAISE(ABORT,'"
                    )
                    + canary
                    + "'); END"
                )
                db.commit()
            response = await clients[0].post(
                "/api/v1/auth/logout", json={}, headers=safe_headers
            )
            assert response.status_code == 503
            assert response.json()["error"]["code"] == "service_unavailable"
            assert all(c not in response.text for c in canaries)
            assert "set-cookie" not in response.headers
            with closing(sqlite3.connect(path)) as db:
                assert (
                    db.execute("SELECT * FROM auth_sessions ORDER BY id").fetchall()
                    == before
                )
                db.execute("DROP TRIGGER fail_logout")
                db.commit()
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(
                (
                    "GET /"
                    + canary
                    + " HTTP/1.1\r\nHost: test\r\n"
                    + canary
                    + "\r\n\r\n"
                ).encode()
            )
            await writer.drain()
            rejected = await asyncio.wait_for(reader.read(), 2)
            writer.close()
            await writer.wait_closed()
            assert b"400" in rejected.split(b"\r\n", 1)[0]
            assert (
                canary.encode() not in rejected
                and b"x-request-id" not in rejected.lower()
            )
            records = [
                r
                for r in caplog.records
                if r.name.startswith(("lexicona", "uvicorn", "sqlalchemy", "aiosqlite"))
            ]
            assert records
            assert all(c not in repr(r.__dict__) for r in records for c in canaries)
            assert all("$argon2" not in repr(r.__dict__) for r in records)
            stop.set()
            await pulse
            assert gaps and max(gaps) < 1.0
            print(
                "REAL_ARGON_HTTP",
                {
                    "verifies": hasher.calls,
                    "peak_native": hasher.peak,
                    "eventloop_max_gap_ms": max(gaps) * 1000,
                    "health_p95_ms": p95(health_seconds),
                    "login_p95_ms": p95(login_seconds),
                    "native_p95_ms": p95(hasher.native_seconds),
                    "writer_ms": writer_ms,
                    "rss_peak_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                },
            )
        finally:
            hasher.release.set()
            stop.set()
            if pulse is not None:
                await pulse
            await asyncio.gather(*tasks, return_exceptions=True)
            for client in clients:
                await client.aclose()
            server.should_exit = True
            await asyncio.wait_for(serving, 10)
    with closing(sqlite3.connect(path)) as db:
        assert db.execute("PRAGMA journal_mode").fetchone() == ("wal",)
        assert db.execute(
            "SELECT count(*) FROM auth_sessions WHERE user_id IS NOT NULL AND "
            "revoked_at IS NULL"
        ).fetchone() == (5,)

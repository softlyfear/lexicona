"""Real loopback HTTP: Argon registration race, writer freedom and safe metadata."""

import asyncio
import logging
import resource
import secrets
import socket
import sqlite3
import threading
from contextlib import closing
from time import monotonic

import httpx
import pytest
import uvicorn
from invite_helpers import CREATE, REGISTER, admin_headers
from test_auth_http import COOKIE, STAMP, SignedIn
from test_auth_http import signed_in as signed_in

from lexicona.app import create_app
from lexicona.auth.config import AuthConfig
from lexicona.auth.passwords import ArgonHasher, Hasher

__all__ = ["signed_in"]


async def test_real_register_race_heartbeat_and_forwarded_peer(
    signed_in: SignedIn, caplog: pytest.LogCaptureFixture
) -> None:
    a = signed_in
    inner = ArgonHasher()
    lock = threading.Lock()
    both = threading.Event()
    release = threading.Event()
    count = 0
    running = 0
    peak = 0
    durations: list[float] = []

    def hash_password(value: str) -> str:
        nonlocal count, running, peak
        with lock:
            count += 1
            dummy = count == 1
            if not dummy:
                running += 1
                peak = max(peak, running)
                if running == 2:
                    both.set()
        try:
            if not dummy and not release.wait(5):
                raise RuntimeError("hash barrier timed out")
            start = monotonic()
            result = inner.hash(value)
            if not dummy:
                with lock:
                    durations.append(monotonic() - start)
            return result
        finally:
            if not dummy:
                with lock:
                    running -= 1

    caplog.set_level(logging.INFO, logger="lexicona.http")
    canaries: list[str] = []
    with closing(socket.socket()) as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        assert port not in {8000, 5173}
        origin = f"http://127.0.0.1:{port}"
        app = create_app(
            f"sqlite+aiosqlite:///{a.path}",
            auth_config=AuthConfig(origin),
            clock=lambda: a.clock[0],
            password_hasher=Hasher(hash_password, inner.verify),
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
        tasks: list[asyncio.Task[httpx.Response]] = []
        stop = asyncio.Event()
        gaps: list[float] = []

        async def heartbeat() -> None:
            previous = monotonic()
            while not stop.is_set():
                await asyncio.sleep(0.01)
                now = monotonic()
                gaps.append(now - previous)
                previous = now

        pulse: asyncio.Task[None] | None = None
        try:
            async with asyncio.timeout(5):
                while not server.started:
                    assert not serving.done()
                    await asyncio.sleep(0.01)
            async with (
                httpx.AsyncClient(
                    base_url=origin,
                    headers={"Origin": origin},
                    cookies={COOKIE: a.client.cookies[COOKIE]},
                ) as admin,
                httpx.AsyncClient(base_url=origin, headers={"Origin": origin}) as first,
                httpx.AsyncClient(
                    base_url=origin, headers={"Origin": origin}
                ) as second,
            ):
                created = await admin.post(CREATE, json={}, headers=admin_headers(a))
                assert created.status_code == 201
                invitation = created.json()
                canaries.append(invitation["invite_token"])
                listed = await admin.get(CREATE)
                assert listed.json() == {
                    "items": [invitation["invite"]],
                    "next_cursor": None,
                }
                assert canaries[0] not in listed.text
                pre = await asyncio.gather(
                    first.get("/api/v1/auth/csrf"), second.get("/api/v1/auth/csrf")
                )
                pulse = asyncio.create_task(heartbeat())
                for client, csrf, login in zip(
                    [first, second], pre, ["wire_first", "wire_second"], strict=True
                ):
                    password = secrets.token_urlsafe(24)
                    canaries += [
                        password,
                        csrf.json()["csrf_token"],
                        client.cookies[COOKIE],
                    ]
                    tasks.append(
                        asyncio.create_task(
                            client.post(
                                REGISTER,
                                json={
                                    "login": login,
                                    "display_name": "Имя",
                                    "password": password,
                                    "invite_token": canaries[0],
                                },
                                headers={
                                    "X-CSRF-Token": csrf.json()["csrf_token"],
                                    "X-Lexicona-Expected-Principal": "anonymous",
                                },
                            )
                        )
                    )
                assert await asyncio.to_thread(both.wait, 3)

                def writer() -> None:
                    with closing(sqlite3.connect(a.path, timeout=0.5)) as db:
                        db.execute("BEGIN IMMEDIATE")
                        db.execute("UPDATE users SET display_name=display_name")
                        db.commit()

                start = monotonic()
                await asyncio.wait_for(asyncio.to_thread(writer), 1)
                writer_ms = (monotonic() - start) * 1000
                release.set()
                health: list[float] = []
                while not all(task.done() for task in tasks):
                    start = monotonic()
                    response = await admin.get("/api/v1/health/live")
                    health.append((monotonic() - start) * 1000)
                    assert response.json() == {"status": "alive"}
                    await asyncio.sleep(0.01)
                results = await asyncio.gather(*tasks)
                assert sorted(response.status_code for response in results) == [
                    201,
                    400,
                ]
                assert all(
                    response.headers[STAMP] == "anonymous" for response in results
                )
                assert peak == 2 and len(durations) == 2 and max(gaps) < 1
                listed = await admin.get(CREATE)
                assert listed.json()["items"][0]["state"] == "used"
                assert all(value not in listed.text for value in canaries)
                assert set(listed.json()["items"][0]) == {
                    "id",
                    "created_by",
                    "created_at",
                    "expires_at",
                    "used_at",
                    "revoked_at",
                    "state",
                    "version",
                }
                new = await admin.post(CREATE, json={}, headers=admin_headers(a))
                assert new.status_code == 201
                canaries.append(new.json()["invite_token"])
                revoked = await admin.post(
                    CREATE + "/" + new.json()["invite"]["id"] + "/revoke",
                    json={"expected_version": 1},
                    headers=admin_headers(a),
                )
                assert (
                    revoked.status_code == 200 and revoked.json()["state"] == "revoked"
                )
                assert all(value not in revoked.text for value in canaries)
                # Independent new P. Forged forwarded peers cannot bypass the
                # token failure bucket or change configured public origin.
                first.cookies.clear()
                preauth = await first.get("/api/v1/auth/csrf")
                unknown = secrets.token_urlsafe(32)
                data = {
                    "invite_token": unknown,
                    "login": "unknown",
                    "display_name": "Имя",
                    "password": secrets.token_urlsafe(24),
                }
                headers = {
                    "X-CSRF-Token": preauth.json()["csrf_token"],
                    "X-Lexicona-Expected-Principal": "anonymous",
                }
                for i in range(6):
                    response = await first.post(
                        REGISTER,
                        json=data,
                        headers=headers
                        | {
                            "X-Forwarded-For": f"192.0.2.{i + 1}",
                            "X-Forwarded-Proto": "https",
                        },
                    )
                    assert response.status_code == (400 if i < 5 else 429)
                    assert "set-cookie" not in response.headers
                records = [
                    record
                    for record in caplog.records
                    if record.name.startswith(
                        ("lexicona", "aiosqlite", "sqlalchemy", "uvicorn")
                    )
                ]
                assert records
                assert all(
                    value not in repr(record.__dict__)
                    for record in records
                    for value in canaries
                )
                print(
                    {
                        "registration_hashes": len(durations),
                        "peak_native": peak,
                        "eventloop_max_gap_ms": max(gaps) * 1000,
                        "hash_max_ms": max(durations) * 1000,
                        "health_max_ms": max(health),
                        "writer_ms": writer_ms,
                        "rss_peak_kib": resource.getrusage(
                            resource.RUSAGE_SELF
                        ).ru_maxrss,
                    }
                )
        finally:
            release.set()
            stop.set()
            if pulse is not None:
                await pulse
            await asyncio.gather(*tasks, return_exceptions=True)
            server.should_exit = True
            await asyncio.wait_for(serving, 10)
    with closing(sqlite3.connect(a.path)) as db:
        assert db.execute(
            "SELECT count(*) FROM users WHERE role='user'"
        ).fetchone() == (1,)
        assert db.execute(
            "SELECT count(*) FROM invites WHERE used_at IS NOT NULL"
        ).fetchone() == (1,)
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []

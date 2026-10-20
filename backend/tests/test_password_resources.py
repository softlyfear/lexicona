"""Resource, cancellation, and heartbeat proofs, not HTTP anti-abuse acceptance."""

import asyncio
import json
import resource
import secrets
from pathlib import Path
from time import monotonic

import httpx
import pytest
from test_auth_schema import migrate
from test_passwords import BarrierHasher, until

from lexicona.app import create_app
from lexicona.auth.passwords import Hasher, PasswordBusy, PasswordService


async def test_queue_two_second_cap_drops_secret_and_expired_fifo_does_not_start() -> (
    None
):
    hasher = BarrierHasher()
    service = PasswordService(Hasher(hasher.hash, hasher.verify))
    running = []
    for n in range(2):
        running.append(
            asyncio.create_task(service.hash(str(n), deadline=monotonic() + 10))
        )
        await hasher.wait_started(str(n))
    try:
        start = monotonic()
        queued = asyncio.create_task(service.hash("2", deadline=monotonic() + 10))
        await until(lambda: service.waiting == 1)
        job = service._pending[0]
        with pytest.raises(PasswordBusy):
            await queued
        assert 1.8 <= monotonic() - start < 3
        assert service.waiting == 0 and job.work is None
        queued = asyncio.create_task(service.hash("3", deadline=monotonic() + 10))
        await until(lambda: service.waiting == 1)
        job = service._pending[0]
        job.expires = monotonic() - 1
        # Force the dispatch-boundary expiry independently of the timer callback.
        hasher.gates["0"].set()
        with pytest.raises(PasswordBusy):
            await queued
        assert job.work is None and hasher.started == ["0", "1"]
    finally:
        for gate in hasher.gates.values():
            gate.set()
        await asyncio.gather(*running)
        await service.aclose()


async def test_cancelled_running_failure_keeps_permit_until_real_completion() -> None:
    class Failing(BarrierHasher):
        def hash(self, password: str) -> str:
            super().hash(password)
            raise RuntimeError("synthetic backend failure")

    hasher = Failing()
    service = PasswordService(Hasher(hasher.hash, hasher.verify))
    task = asyncio.create_task(service.hash("0", deadline=monotonic() + 10))
    try:
        await until(lambda: service.running == 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert service.running == 1
        hasher.gates["0"].set()
        await until(lambda: service.running == 0)
    finally:
        hasher.gates["0"].set()
        await service.aclose()


async def test_real_two_hashes_allow_live_asgi_heartbeat(tmp_path: Path) -> None:
    from asgi_lifespan import LifespanManager

    path = tmp_path / "heartbeat.sqlite3"
    await asyncio.to_thread(migrate, path)
    app = create_app(f"sqlite+aiosqlite:///{path}")
    service = PasswordService()
    secret = " \n😀e\u0301" + secrets.token_urlsafe(24)
    durations: list[float] = []
    gaps: list[float] = []
    before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

    async def hash_one() -> None:
        start = monotonic()
        encoded = await service.hash(secret, deadline=start + 10)
        durations.append(monotonic() - start)
        assert encoded.startswith("$argon2id$v=19$m=65536,t=3,p=1$")

    try:
        async with (
            LifespanManager(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client,
        ):
            jobs = [asyncio.create_task(hash_one()) for _ in range(2)]
            previous = monotonic()
            while not all(job.done() for job in jobs):
                response = await client.get("/api/v1/health/live")
                assert response.status_code == 200 and response.json() == {
                    "status": "alive"
                }
                assert response.headers["cache-control"] == "no-store"
                await asyncio.sleep(0.01)
                now = monotonic()
                gaps.append(now - previous)
                previous = now
            await asyncio.gather(*jobs)
        assert gaps and max(gaps) < 1
        reports = Path(".local-reports")
        await asyncio.to_thread(reports.mkdir, exist_ok=True)
        await asyncio.to_thread(
            (reports / "argon-heartbeat.json").write_text,
            json.dumps(
                {
                    "hash_seconds": durations,
                    "samples": len(gaps),
                    "max_gap_seconds": max(gaps),
                    "ru_maxrss_before_kib": before,
                    "ru_maxrss_after_kib": resource.getrusage(
                        resource.RUSAGE_SELF
                    ).ru_maxrss,
                    "two_hash_sample_not_p95": True,
                    "http_anti_abuse_not_implemented": True,
                },
                indent=2,
            )
            + "\n",
        )
    finally:
        await service.aclose()

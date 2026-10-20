"""Bounded password work: real profile and deterministic admission barriers."""

import asyncio
import secrets
import threading
from collections.abc import Callable
from time import monotonic

import pytest
from argon2 import Type, extract_parameters


async def test_real_password_profile_and_verbatim_unicode() -> None:
    from lexicona.auth.passwords import PasswordService

    secret = " \nÉe\u0301😀" + secrets.token_urlsafe(24) + " "
    service = PasswordService()
    try:
        encoded = await service.hash(secret, deadline=monotonic() + 10)
        p = extract_parameters(encoded)
        assert (
            p.type,
            p.version,
            p.memory_cost,
            p.time_cost,
            p.parallelism,
            p.salt_len,
            p.hash_len,
        ) == (Type.ID, 19, 65536, 3, 1, 16, 32)
        assert await service.verify(encoded, secret, deadline=monotonic() + 10)
        assert not await service.verify(
            encoded, secret.strip(), deadline=monotonic() + 10
        )
        assert not await service.verify(
            encoded, secret.replace("e\u0301", "é"), deadline=monotonic() + 10
        )
    finally:
        await service.aclose()


class BarrierHasher:
    def __init__(self) -> None:
        self.started: list[str] = []
        self.gates = {str(n): threading.Event() for n in range(10)}
        self.loop = asyncio.get_running_loop()
        self.entries: asyncio.Queue[str] = asyncio.Queue()

    async def wait_started(self, label: str) -> None:
        assert await asyncio.wait_for(self.entries.get(), 3) == label

    def hash(self, password: str) -> str:
        self.started.append(password)
        self.loop.call_soon_threadsafe(self.entries.put_nowait, password)
        assert self.gates[password].wait(5)
        return "encoded"

    def verify(self, encoded: str, password: str) -> bool:
        return self.hash(password) == encoded


async def until(check: Callable[[], bool]) -> None:
    for _ in range(3000):
        if check():
            return
        await asyncio.sleep(0.001)
    pytest.fail("Barrier not reached")


async def test_fifo_two_running_four_waiting_full_cancel_and_running_permit() -> None:
    from lexicona.auth.passwords import Hasher, PasswordBusy, PasswordService

    loop = asyncio.get_running_loop()
    hasher = BarrierHasher()
    service = PasswordService(Hasher(hasher.hash, hasher.verify))
    tasks: list[asyncio.Task[str]] = []

    async def admitted(label: str, ready: asyncio.Event) -> str:
        # _submit reaches its await before this callback acknowledges admission.
        loop.call_soon(ready.set)
        return await service.hash(label, deadline=monotonic() + 10)

    try:
        for n in range(6):
            ready = asyncio.Event()
            tasks.append(asyncio.create_task(admitted(str(n), ready)))
            await asyncio.wait_for(ready.wait(), 3)
            if n < 2:
                await hasher.wait_started(str(n))
        assert service.running == 2 and service.waiting == 4
        with pytest.raises(PasswordBusy):
            await service.hash("6", deadline=monotonic() + 10)
        cancelled = service._pending[0]
        tasks[2].cancel()
        with pytest.raises(asyncio.CancelledError):
            await tasks[2]
        assert service.waiting == 3 and cancelled.work is None
        tasks[0].cancel()
        with pytest.raises(asyncio.CancelledError):
            await tasks[0]
        assert service.running == 2
        assert hasher.started == ["0", "1"]
        # Keep worker 1 occupied: exactly one free slot makes thread-entry order
        # a valid witness for FIFO dispatch, independent of OS worker scheduling.
        for finished, following, expected in [
            ("0", "3", ["0", "1", "3"]),
            ("3", "4", ["0", "1", "3", "4"]),
            ("4", "5", ["0", "1", "3", "4", "5"]),
        ]:
            hasher.gates[finished].set()
            await hasher.wait_started(following)
            assert hasher.started == expected
            assert service.running == 2
        hasher.gates["1"].set()
        hasher.gates["5"].set()
        for n in [1, 3, 4, 5]:
            assert await tasks[n] == "encoded"
        assert hasher.started == ["0", "1", "3", "4", "5"]
    finally:
        for gate in hasher.gates.values():
            gate.set()
        await service.aclose()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_pending_deadline_queue_cap_shutdown_and_backend_failure() -> None:
    from lexicona.auth.passwords import (
        Hasher,
        PasswordBusy,
        PasswordService,
        PasswordUnavailable,
    )

    hasher = BarrierHasher()
    service = PasswordService(Hasher(hasher.hash, hasher.verify))
    first = []
    for n in range(2):
        first.append(
            asyncio.create_task(service.hash(str(n), deadline=monotonic() + 10))
        )
        await hasher.wait_started(str(n))
    expired = asyncio.create_task(service.hash("2", deadline=monotonic() + 0.03))
    with pytest.raises(PasswordBusy):
        await expired
    assert service.waiting == 0 and hasher.started == ["0", "1"]
    queued = asyncio.create_task(service.hash("3", deadline=monotonic() + 10))
    await until(lambda: service.waiting == 1)
    close = asyncio.create_task(service.aclose())
    with pytest.raises(asyncio.CancelledError):
        await queued
    assert service.waiting == 0
    assert not close.done()
    with pytest.raises(PasswordBusy):
        await service.hash("4", deadline=monotonic() + 10)
    close.cancel()
    await asyncio.sleep(0)
    assert not close.done()
    for gate in hasher.gates.values():
        gate.set()
    await asyncio.gather(*first)
    with pytest.raises(asyncio.CancelledError):
        await close
    await service.aclose()
    assert service.running == 0
    service = PasswordService()
    try:
        with pytest.raises(PasswordBusy):
            await service.hash("unused", deadline=monotonic() - 1)
        with pytest.raises(PasswordUnavailable):
            await service.verify("corrupt", "unused", deadline=monotonic() + 2)
    finally:
        await service.aclose()


async def test_invalid_phc_is_rejected_before_expensive_verify() -> None:
    from lexicona.auth.passwords import ArgonHasher

    hasher = ArgonHasher()
    secret = secrets.token_urlsafe(24)
    encoded = hasher.hash(secret)
    for bad in [
        encoded.replace("m=65536", "m=65536000"),
        encoded.replace("v=19", "v=16"),
        "x" * 513,
    ]:
        with pytest.raises(ValueError):
            hasher.verify(bad, secret)


async def test_executor_submission_failure_does_not_leak_a_permit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from lexicona.auth.passwords import PasswordService, PasswordUnavailable

    service = PasswordService()

    def unavailable(*args: object, **kwargs: object) -> object:
        raise RuntimeError("backend unavailable")

    monkeypatch.setattr(service._executor, "submit", unavailable)
    try:
        with pytest.raises(PasswordUnavailable):
            await service.hash("synthetic-test-only", deadline=monotonic() + 2)
        assert service.running == 0 and service.waiting == 0
    finally:
        await service.aclose()


async def test_password_work_and_join_never_use_the_default_executor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from lexicona.auth.passwords import PasswordService

    loop = asyncio.get_running_loop()

    def forbidden(*args: object, **kwargs: object) -> object:
        pytest.fail("Password work/cleanup used the default executor")

    monkeypatch.setattr(loop, "run_in_executor", forbidden)
    service = PasswordService()
    try:
        secret = secrets.token_urlsafe(24)
        encoded = await service.hash(secret, deadline=monotonic() + 10)
        assert await service.verify(encoded, secret, deadline=monotonic() + 10)
    finally:
        await service.aclose()

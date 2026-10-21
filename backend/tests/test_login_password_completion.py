"""Actual native completion, independent from the cancelled asyncio caller."""

import asyncio
from time import monotonic

import pytest
from test_passwords import BarrierHasher, until

from lexicona.auth.passwords import Hasher, PasswordBusy, PasswordService
from lexicona.auth.rates import Rates


@pytest.mark.parametrize("cancel", [True, False])
async def test_running_reservation_survives_caller_and_window_end(cancel: bool) -> None:
    clock = [0.0]
    rates = Rates(lambda: clock[0])
    for _ in range(4):
        rates.login("account", "peer").finish()
    permit = rates.login("account", "peer")
    hasher = BarrierHasher()
    service = PasswordService(Hasher(hasher.hash, hasher.verify))

    async def request() -> None:
        permit.start()
        try:
            await service.verify(
                "encoded",
                "0",
                deadline=monotonic() + (10 if cancel else 0.05),
                on_complete=permit.completed,
            )
        finally:
            permit.finish()

    task = asyncio.create_task(request())
    try:
        await hasher.wait_started("0")
        if cancel:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            with pytest.raises(PasswordBusy):
                await task
        assert service.running == 1
        assert next(iter(rates.accounts.entries.values())).active == 1
        clock[0] = 900
        # The expired failure count is gone, but native work still occupies one.
        more = [rates.login("account", "peer") for _ in range(4)]
        from lexicona.auth.errors import AuthError

        with pytest.raises(AuthError):
            rates.login("account", "peer")
        for other in more:
            other.finish(success=True)
        hasher.gates["0"].set()
        await until(lambda: service.running == 0)
        assert next(iter(rates.accounts.entries.values())).active == 0
        assert next(iter(rates.accounts.entries.values())).count == 1
    finally:
        hasher.gates["0"].set()
        await service.aclose()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("terminal", ["cancel", "deadline", "queue-expire", "close"])
async def test_pending_hook_runs_once_without_starting_native_work(
    terminal: str,
) -> None:
    hasher = BarrierHasher()
    service = PasswordService(Hasher(hasher.hash, hasher.verify))
    running = []
    for n in range(2):
        running.append(
            asyncio.create_task(service.hash(str(n), deadline=monotonic() + 10))
        )
        await hasher.wait_started(str(n))
    calls: list[int] = []
    pending = asyncio.create_task(
        service.verify(
            "encoded",
            "2",
            deadline=monotonic() + (0.03 if terminal == "deadline" else 10),
            on_complete=lambda: calls.append(service.running),
        )
    )
    await until(lambda: service.waiting == 1)
    job = service._pending[0]
    close: asyncio.Task[None] | None = None
    try:
        if terminal == "cancel":
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
        elif terminal == "deadline":
            with pytest.raises(PasswordBusy):
                await pending
        elif terminal == "queue-expire":
            job.expires = monotonic() - 1
            hasher.gates["0"].set()
            with pytest.raises(PasswordBusy):
                await pending
        else:
            close = asyncio.create_task(service.aclose())
            with pytest.raises(asyncio.CancelledError):
                await pending
        assert service.waiting == 0
        assert job.work is None and job.on_complete is None
        assert len(calls) == 1
        assert hasher.started == ["0", "1"]
    finally:
        for gate in hasher.gates.values():
            gate.set()
        await asyncio.gather(*running, pending, return_exceptions=True)
        if close is not None:
            await close
        await service.aclose()
    assert len(calls) == 1


async def test_completion_on_full_expired_closed_and_submit_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from lexicona.auth.passwords import PasswordUnavailable

    hasher = BarrierHasher()
    service = PasswordService(Hasher(hasher.hash, hasher.verify))
    calls: list[str] = []
    tasks = []
    try:
        for n in range(6):
            tasks.append(
                asyncio.create_task(service.hash(str(n), deadline=monotonic() + 10))
            )
            if n < 2:
                await hasher.wait_started(str(n))
        await until(lambda: service.waiting == 4)
        with pytest.raises(PasswordBusy):
            await service.verify(
                "encoded",
                "6",
                deadline=monotonic() + 10,
                on_complete=lambda: calls.append("full"),
            )
        assert calls == ["full"] and service.running == 2
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        for gate in hasher.gates.values():
            gate.set()
        await service.aclose()
    with pytest.raises(PasswordBusy):
        await service.verify(
            "encoded",
            "6",
            deadline=monotonic() + 10,
            on_complete=lambda: calls.append("closed"),
        )
    service = PasswordService()
    try:
        with pytest.raises(PasswordBusy):
            await service.verify(
                "encoded",
                "unused",
                deadline=monotonic() - 1,
                on_complete=lambda: calls.append("deadline"),
            )

        def unavailable(*args: object, **kwargs: object) -> object:
            raise RuntimeError("synthetic backend failure")

        monkeypatch.setattr(service._executor, "submit", unavailable)
        with pytest.raises(PasswordUnavailable):
            await service.verify(
                "encoded",
                "unused",
                deadline=monotonic() + 10,
                on_complete=lambda: calls.append("submit"),
            )
        assert service.running == service.waiting == 0
    finally:
        await service.aclose()
    assert calls == ["full", "closed", "deadline", "submit"]


@pytest.mark.parametrize("cancel", [False, True])
async def test_native_failure_completion_after_or_before_caller_cancel(
    cancel: bool,
) -> None:
    from lexicona.auth.passwords import PasswordUnavailable

    hasher = BarrierHasher()

    def fail(encoded: str, password: str) -> bool:
        hasher.hash(password)
        raise ValueError("synthetic failure")

    service = PasswordService(Hasher(hasher.hash, fail))
    calls: list[int] = []
    task = asyncio.create_task(
        service.verify(
            "encoded",
            "0",
            deadline=monotonic() + 10,
            on_complete=lambda: calls.append(service.running),
        )
    )
    try:
        await hasher.wait_started("0")
        if cancel:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert calls == [] and service.running == 1
        hasher.gates["0"].set()
        if not cancel:
            with pytest.raises(PasswordUnavailable):
                await task
        await until(lambda: service.running == 0)
        assert calls == [0]
    finally:
        hasher.gates["0"].set()
        await service.aclose()
        await asyncio.gather(task, return_exceptions=True)

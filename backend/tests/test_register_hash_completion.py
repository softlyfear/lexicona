"""Registration hash reservations follow actual native Futures, not HTTP tasks."""

import asyncio
import secrets
import threading
from time import monotonic

import pytest
from test_passwords import until

from lexicona.auth.errors import AuthError, Decision
from lexicona.auth.http import LoginPasswords
from lexicona.auth.passwords import Hasher, PasswordService
from lexicona.auth.rates import Rates


@pytest.mark.parametrize("terminal", ["cancel", "deadline", "failure", "success"])
async def test_registration_hash_completion_owns_reservation(terminal: str) -> None:
    loop = asyncio.get_running_loop()
    entered = asyncio.Event()
    release = threading.Event()
    clock = [0.0]
    rates = Rates(lambda: clock[0])
    for _ in range(4):
        rates.register("digest", "peer").finish()
    permit = rates.register("digest", "peer")

    def hash_password(value: str) -> str:
        loop.call_soon_threadsafe(entered.set)
        if not release.wait(5):
            raise RuntimeError("barrier timed out")
        if terminal == "failure":
            raise RuntimeError("native backend failure")
        return "test-encoded-result"

    facade = LoginPasswords()
    service = PasswordService(Hasher(hash_password, lambda encoded, value: False))
    facade.service = service
    secret = secrets.token_urlsafe(24)

    async def caller() -> str:
        success = False
        try:
            result = await facade.hash(
                secret,
                Decision(monotonic() + (0.05 if terminal == "deadline" else 5)),
                permit,
            )
            success = True
            return result
        finally:
            permit.finish(success=success)

    task = asyncio.create_task(caller())
    try:
        await asyncio.wait_for(entered.wait(), 2)
        if terminal == "cancel":
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        elif terminal == "deadline":
            with pytest.raises(AuthError) as caught:
                await task
            assert caught.value.code == "auth_busy"
        if terminal in {"cancel", "deadline"}:
            assert service.running == 1
            assert next(iter(rates.register_tokens.entries.values())).active == 1
            with pytest.raises(AuthError):
                rates.register("digest", "different-peer")
        release.set()
        if terminal == "failure":
            with pytest.raises(AuthError) as caught:
                await task
            assert caught.value.code == "service_unavailable"
        elif terminal == "success":
            assert await task == "test-encoded-result"
        await until(lambda: service.running == 0)
        window = next(iter(rates.register_tokens.entries.values()))
        assert window.active == 0 and window.count == (
            4 if terminal == "success" else 5
        )
        clock[0] = 900
        rates.register("digest", "peer").finish()
    finally:
        release.set()
        await service.aclose()
        await asyncio.gather(task, return_exceptions=True)


async def test_registration_hash_closed_missing_and_expired_service() -> None:
    facade = LoginPasswords()
    rates = Rates()
    permit = rates.register("digest", "peer")
    try:
        with pytest.raises(AuthError) as caught:
            await facade.hash(
                secrets.token_urlsafe(24), Decision(monotonic() + 1), permit
            )
        assert caught.value.code == "service_unavailable"
    finally:
        permit.finish()
    facade.service = PasswordService()
    try:
        permit = rates.register("different", "peer")
        with pytest.raises(AuthError) as caught:
            await facade.hash(
                secrets.token_urlsafe(24), Decision(monotonic() - 1), permit
            )
        assert caught.value.code == "auth_busy"
        permit.finish()
        assert next(iter(rates.register_tokens.entries.values())).active == 0
    finally:
        await facade.close()

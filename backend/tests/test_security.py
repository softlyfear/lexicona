import asyncio
import threading
import time

import pytest

from lexicona.infrastructure import security


def test_login_throttle_does_not_create_keys_for_unknown_logins() -> None:
    throttle = security.LoginThrottle()
    assert throttle.blocked("ghost") is False
    assert throttle._failures == {}


def test_login_throttle_bounds_its_key_table() -> None:
    throttle = security.LoginThrottle(attempts=2, max_keys=3)
    for name in ("a", "b", "c", "d", "e"):
        throttle.fail(name)
    assert len(throttle._failures) <= 3
    assert throttle.blocked("a") is False


def test_login_throttle_keeps_a_live_lockout_when_the_table_is_flooded() -> None:
    throttle = security.LoginThrottle(attempts=2, max_keys=3)
    throttle.fail("victim")
    throttle.fail("victim")
    assert throttle.blocked("victim") is True
    for index in range(8):
        throttle.fail(f"filler-{index}")
    assert len(throttle._failures) <= 3
    assert "victim" in throttle._failures
    assert throttle.blocked("victim") is True

    near = security.LoginThrottle(attempts=3, max_keys=2)
    near.fail("victim")
    near.fail("victim")
    near.fail("filler")
    near.fail("other")
    assert "victim" in near._failures
    assert len(near._failures["victim"]) == 2
    assert len(near._failures) <= 2

    locked = security.LoginThrottle(attempts=1, max_keys=2)
    locked.fail("alice")
    locked.fail("bob")
    locked.fail("carol")
    assert len(locked._failures) <= 2
    assert locked.blocked("alice") is True
    assert locked.blocked("never-seen") is True


def test_login_throttle_forgets_expired_failures() -> None:
    throttle = security.LoginThrottle(attempts=1, window_seconds=0.01)
    throttle.fail("alice")
    time.sleep(0.02)
    assert throttle.blocked("alice") is False


async def test_password_hashing_concurrency_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    active = 0
    peak = 0
    lock = threading.Lock()

    def slow_verify(_hash: str | None, _password: str) -> bool:
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.02)
        with lock:
            active -= 1
        return True

    monkeypatch.setattr(security, "verify_password", slow_verify)
    results = await asyncio.gather(
        *(security.verify_password_limited(None, "secret") for _ in range(12))
    )
    assert results == [True] * 12
    assert peak <= 4

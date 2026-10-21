"""Fixed-window admission and bounded cardinality, with deterministic clocks."""

import hmac
from collections import OrderedDict

import pytest
from starlette.requests import Request

from lexicona.auth.errors import AuthError
from lexicona.auth.rates import Bucket


def test_targeted_expiry_outside_cleanup_sample() -> None:
    now = [0.0]
    bucket = Bucket(1, 60, lambda: now[0])
    for n in range(300):
        bucket.take(str(n))
    # Ensure the target is not among the next bounded cleanup sample.
    target = next(reversed(bucket.entries))
    value = next(
        str(n)
        for n in range(300)
        if hmac.digest(bucket._secret, str(n).encode(), "sha256") == target
    )
    now[0] = 60
    bucket.take(value)
    assert bucket.entries[target].count == 1
    assert bucket.entries[target].end == 120
    with pytest.raises(AuthError):
        bucket.take(value)


def test_independent_axes_atomic_rollback_and_success_history() -> None:
    from lexicona.auth.rates import Rates

    clock = [0.0]
    rates = Rates(lambda: clock[0])
    for n in range(5):
        rates.login("locked", f"ip-{n}").finish()
    assert len(rates.ips.entries) == 5
    with pytest.raises(AuthError):
        rates.login("locked", "uncharged")
    assert len(rates.ips.entries) == 5
    for n in range(5):
        rates.login(f"other-{n}", "ip-full").finish()
    before = len(rates.accounts.entries)
    with pytest.raises(AuthError):
        rates.login("uncharged", "ip-full")
    assert len(rates.accounts.entries) == before
    for _ in range(4):
        rates.login("history", "history-ip").finish()
    success = rates.login("history", "history-ip")
    success.start()
    success.completed()
    success.finish(success=True)
    success.finish()
    success.completed()
    final = rates.login("history", "history-ip")
    final.finish()
    with pytest.raises(AuthError):
        rates.login("history", "history-ip")
    clock[0] = 899.01
    with pytest.raises(AuthError) as error:
        rates.login("history", "history-ip")
    assert error.value.headers == {"Retry-After": "1"}
    clock[0] = 900
    rates.login("history", "history-ip").finish()


def test_both_blocked_retry_uses_latest_end_and_never_extends_ttl() -> None:
    from lexicona.auth.rates import Rates

    clock = [0.0]
    rates = Rates(lambda: clock[0])
    for n in range(5):
        rates.login("account", str(n)).finish()
    clock[0] = 100.25
    for n in range(5):
        rates.login(str(n), "peer").finish()
    clock[0] = 200.5
    for _ in range(3):
        with pytest.raises(AuthError) as error:
            rates.login("account", "peer")
        assert error.value.code == "rate_limited"
        assert error.value.headers == {"Retry-After": "800"}
    clock[0] = 900
    with pytest.raises(AuthError) as error:
        rates.login("account", "peer")
    assert error.value.headers == {"Retry-After": "101"}
    clock[0] = 1000.25
    rates.login("account", "peer").finish()


def test_all_active_expired_blocked_without_changing_end() -> None:
    from lexicona.auth.rates import Rates

    clock = [0.0]
    rates = Rates(lambda: clock[0])
    permits = [rates.login("account", "peer") for _ in range(5)]
    for permit in permits:
        permit.start()
        permit.finish()
    clock[0] = 900
    with pytest.raises(AuthError) as error:
        rates.login("account", "peer")
    assert error.value.headers == {"Retry-After": "1"}
    window = next(iter(rates.accounts.entries.values()))
    assert window.end == 900 and window.active == 5
    permits[0].completed()
    new = rates.login("account", "peer")
    assert window.count == window.active == 5 and window.end == 1800
    for permit in permits[1:]:
        permit.completed()
    new.finish(success=True)
    assert window.count == 4 and window.active == 0


class SweepCounter(OrderedDict[bytes, None]):
    steps: int = 0

    def popitem(self, last: bool = True) -> tuple[bytes, None]:
        self.steps += 1
        return super().popitem(last=last)


def test_request_cleanup_budget_across_general_and_login_axes() -> None:
    from lexicona.auth.rates import Rates

    rates = Rates(lambda: 0.0)
    for n in range(300):
        rates.general.take(str(n))
        rates.login(str(n), str(n)).finish()
    counters = []
    for bucket in (rates.general, rates.accounts, rates.ips):
        counter = SweepCounter(bucket._sweep)
        bucket._sweep = counter
        counters.append(counter)
    rates.general.take("new")
    rates.login("new", "new").finish()
    assert sum(counter.steps for counter in counters) + 3 <= 128


def test_full_maps_do_not_evict_and_cleanup_is_bounded() -> None:
    from lexicona.auth.rates import Rates

    clock = [0.0]
    rates = Rates(lambda: clock[0])
    for n in range(10000):
        rates.login(f"account-{n}", f"ip-{n}").finish()
    for bucket in (rates.accounts, rates.ips):
        assert len(bucket.entries) == len(bucket._sweep) == 10000
        assert all(isinstance(key, bytes) and len(key) == 32 for key in bucket.entries)
        bucket._sweep = SweepCounter(bucket._sweep)
    for _ in range(4):
        rates.login("account-0", "ip-0").finish()
    with pytest.raises(AuthError):
        rates.login("account-0", "ip-0")
    for bucket in (rates.accounts, rates.ips):
        assert isinstance(bucket._sweep, SweepCounter)
        bucket._sweep.steps = 0
    clock[0] = 0.1
    with pytest.raises(AuthError) as error:
        rates.login("new-account", "new-ip")
    assert error.value.headers == {"Retry-After": "900"}
    for bucket in (rates.accounts, rates.ips):
        assert isinstance(bucket._sweep, SweepCounter)
        assert bucket._sweep.steps == 31
        assert len(bucket.entries) == len(bucket._sweep) == 10000
    clock[0] = 900
    rates.login("new-account", "new-ip").finish()
    for bucket in (rates.accounts, rates.ips):
        assert isinstance(bucket._sweep, SweepCounter)
        assert bucket._sweep.steps == 62
        assert len(bucket.entries) == len(bucket._sweep) == 9970
    # A newly constructed process-local service has no durable counters/key reuse.
    fresh = Rates(lambda: clock[0])
    assert not fresh.accounts.entries and not fresh.ips.entries
    assert fresh.accounts._secret != rates.accounts._secret


@pytest.mark.parametrize("limit,seconds", [(120, 60), (20, 60)])
def test_general_and_issuance_full_map_old_key_and_expiry(
    limit: int, seconds: int
) -> None:
    clock = [0.0]
    bucket = Bucket(limit, seconds, lambda: clock[0])
    for n in range(10000):
        bucket.take(str(n))
    with pytest.raises(AuthError):
        bucket.take("new")
    for _ in range(limit - 1):
        bucket.take("0")
    with pytest.raises(AuthError):
        bucket.take("0")
    clock[0] = float(seconds)
    bucket.take("new")
    assert len(bucket.entries) == 9970


@pytest.mark.parametrize(
    "host,expected",
    [
        (None, "unknown"),
        ("invalid", "unknown"),
        ("::ffff:192.0.2.1", "192.0.2.1"),
        ("2001:0db8::1", "2001:db8::1"),
        ("192.0.2.1", "192.0.2.1"),
    ],
)
def test_socket_peer_normalization_ignores_forwarded(
    host: str | None, expected: str
) -> None:
    from lexicona.auth.rates import peer

    request = Request(
        {
            "type": "http",
            "client": (host, 12345) if host else None,
            "headers": [(b"x-forwarded-for", b"198.51.100.1")],
        }
    )
    assert peer(request) == expected

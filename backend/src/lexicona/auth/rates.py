"""Bounded process-local fixed windows; restart clears all counters (not durable)."""

import hashlib
import hmac
import math
import secrets
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from ipaddress import ip_address
from time import monotonic

from starlette.requests import Request

from lexicona.auth.errors import AuthError


@dataclass(repr=False)
class Window:
    end: float
    count: int = 0
    active: int = 0


def peer(request: Request) -> str:
    """Only socket peer; deployment must disable proxy-header rewriting."""
    if request.client is None:
        return "unknown"
    try:
        value = ip_address(request.client.host)
        return str(getattr(value, "ipv4_mapped", None) or value)
    except ValueError:
        return "unknown"


def blocked(end: float, now: float) -> None:
    """Return one generic error, independent of which axis rejected admission."""
    raise AuthError(
        "rate_limited", headers={"Retry-After": str(max(1, math.ceil(end - now)))}
    )


class Bucket:
    """No live eviction; insertion order tracks expiry, separate bounded sweep."""

    def __init__(
        self, limit: int, seconds: int, clock: Callable[[], float] = monotonic
    ) -> None:
        self.limit = limit
        self.seconds = seconds
        self.clock = clock
        self._secret = secrets.token_bytes(32)
        self.entries: OrderedDict[bytes, Window] = OrderedDict()
        self._sweep: OrderedDict[bytes, None] = OrderedDict()

    def _inspect(
        self, value: str, now: float
    ) -> tuple[bytes, Window | None, float | None]:
        digest = hmac.digest(self._secret, value.encode("utf-8"), hashlib.sha256)
        # The requested key must expire even when outside the sweep sample.
        current = self.entries.get(digest)
        if current is not None and now >= current.end and not current.active:
            del self.entries[digest]
            del self._sweep[digest]
            current = None
        # An HTTP request touches at most three maps: 32 entries each,
        # including its targeted lookup, stays below 128 total cleanup steps.
        for _ in range(min(31, len(self._sweep))):
            key, _ = self._sweep.popitem(last=False)
            window = self.entries[key]
            if now >= window.end and not window.active:
                del self.entries[key]
            else:
                self._sweep[key] = None
        if current is None:
            if len(self.entries) >= 10000:
                return digest, None, next(iter(self.entries.values())).end
        elif (current.count if now < current.end else current.active) >= self.limit:
            return digest, current, current.end
        return digest, current, None

    def _admit(self, digest: bytes, current: Window | None, now: float) -> Window:
        if current is None:
            current = Window(now + self.seconds)
            self.entries[digest] = current
            self._sweep[digest] = None
        elif now >= current.end:
            # Expired failures vanish; actual native jobs still occupy slots.
            current.count = current.active
            current.end = now + self.seconds
            self.entries.move_to_end(digest)
        current.count += 1
        return current

    def take(self, value: str) -> None:
        """Count an admission, including unsuccessful requests in the same window."""
        now = self.clock()
        digest, current, end = self._inspect(value, now)
        if end is not None:
            blocked(end, now)
        self._admit(digest, current, now)


class Reservation:
    """Own only counters, never credentials; completion is event-loop-owned."""

    def __init__(self, windows: tuple[Window, Window]) -> None:
        self._windows = windows
        self._finished = False
        self._native_done = True
        self._request_done = False
        self._success = False

    def start(self) -> None:
        """Transfer completion ownership before submitting password work."""
        self._native_done = False

    def completed(self) -> None:
        """Called only on native completion or confirmed non-submission."""
        self._native_done = True
        self._settle()

    def finish(self, *, success: bool = False) -> None:
        """HTTP termination alone cannot release a running native reservation."""
        if self._request_done:
            return
        self._request_done = True
        self._success = success
        self._settle()

    def _settle(self) -> None:
        if self._finished or not self._request_done or not self._native_done:
            return
        self._finished = True
        for window in self._windows:
            window.active -= 1
            if self._success:
                window.count -= 1


class Rates:
    """Independent caps; login dual admission is atomic without yielding."""

    def __init__(self, clock: Callable[[], float] = monotonic) -> None:
        self.general = Bucket(120, 60, clock)
        self.issuance = Bucket(20, 60, clock)
        self.accounts = Bucket(5, 900, clock)
        self.ips = Bucket(5, 900, clock)
        self._clock = clock

    def login(self, account: str, address: str) -> Reservation:
        """Reserve both axes, or neither; callers supply validated canonical keys."""
        now = self._clock()
        account_key, account_window, account_end = self.accounts._inspect(account, now)
        ip_key, ip_window, ip_end = self.ips._inspect(address, now)
        ends = [end for end in (account_end, ip_end) if end is not None]
        if ends:
            blocked(max(ends), now)
        windows = (
            self.accounts._admit(account_key, account_window, now),
            self.ips._admit(ip_key, ip_window, now),
        )
        for window in windows:
            window.active += 1
        return Reservation(windows)

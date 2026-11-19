import hashlib
import secrets
import threading
import time
from collections import deque

from anyio import to_thread
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()
# Verified against when the login is unknown, so both paths cost the same time.
_DUMMY_HASH = _hasher.hash(secrets.token_hex(16))
# Argon2id uses 64 MiB per verification. Bound the parallel work so an
# unauthenticated burst cannot exhaust the host memory. A thread semaphore keeps
# the limit independent of the event loop that happens to be running.
_HASH_SLOTS = threading.BoundedSemaphore(4)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except VerificationError, InvalidHashError:
        return False


def _hash_with_slot(password: str) -> str:
    with _HASH_SLOTS:
        return hash_password(password)


def _verify_with_slot(password_hash: str | None, password: str) -> bool:
    with _HASH_SLOTS:
        return verify_password(password_hash, password)


async def hash_password_limited(password: str) -> str:
    return await to_thread.run_sync(_hash_with_slot, password)


async def verify_password_limited(password_hash: str | None, password: str) -> bool:
    return await to_thread.run_sync(_verify_with_slot, password_hash, password)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class LoginThrottle:
    """In-memory limit of failed logins per login name. Enough for one process.

    Keys are bounded: a client cannot grow the failure table without limit by
    sending arbitrary login names.
    """

    def __init__(
        self, attempts: int = 10, window_seconds: float = 15 * 60, max_keys: int = 10_000
    ) -> None:
        self.attempts = attempts
        self.window = window_seconds
        self.max_keys = max_keys
        self._failures: dict[str, deque[float]] = {}

    def _recent(self, key: str, *, create: bool) -> deque[float] | None:
        failures = self._failures.get(key)
        if failures is None:
            if not create:
                return None
            if len(self._failures) >= self.max_keys:
                self._evict()
            if len(self._failures) >= self.max_keys:
                return None
            failures = deque()
            self._failures[key] = failures
        cutoff = time.monotonic() - self.window
        while failures and failures[0] < cutoff:
            failures.popleft()
        return failures

    def _evict(self) -> None:
        cutoff = time.monotonic() - self.window
        for key, failures in list(self._failures.items()):
            while failures and failures[0] < cutoff:
                failures.popleft()
            if not failures:
                del self._failures[key]
        if len(self._failures) < self.max_keys:
            return
        # A flood of fresh names must not flush a targeted account. Evict the
        # non-blocked key with the fewest failures first; a live lockout is never
        # removed. If every slot is a live lockout, the caller fails closed.
        order = {key: index for index, key in enumerate(self._failures)}
        disposable = sorted(
            (
                (len(failures), order[key], key)
                for key, failures in self._failures.items()
                if len(failures) < self.attempts
            )
        )
        for _count, _index, key in disposable:
            del self._failures[key]
            if len(self._failures) < self.max_keys:
                return

    def blocked(self, key: str) -> bool:
        if key not in self._failures and len(self._failures) >= self.max_keys:
            self._evict()
            # The table is full of live lockouts. Unknown names are blocked so
            # flooding new logins cannot reset a targeted account.
            if key not in self._failures and len(self._failures) >= self.max_keys:
                return True
        failures = self._recent(key, create=False)
        return failures is not None and len(failures) >= self.attempts

    def fail(self, key: str) -> None:
        failures = self._recent(key, create=True)
        if failures is None:
            return
        failures.append(time.monotonic())

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)

"""Dedicated password executor: two running jobs, four removable FIFO waiters."""

import asyncio
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from threading import Thread
from typing import cast

from argon2 import PasswordHasher, Type, extract_parameters
from argon2.exceptions import VerifyMismatchError


class PasswordBusy(Exception):
    """Admission, queue or execution deadline exhausted; no secret diagnostics."""


class PasswordUnavailable(Exception):
    """A backend failure, not a password mismatch."""


@dataclass(frozen=True, repr=False)
class Hasher:
    """Typed synchronous callables, executed only in the dedicated executor."""

    hash: Callable[[str], str]
    verify: Callable[[str, str], bool]


class ArgonHasher:
    """High-level Argon2id with an explicit, non-cheap production profile."""

    def __init__(self) -> None:
        self._hasher = PasswordHasher(
            type=Type.ID,
            memory_cost=65536,
            time_cost=3,
            parallelism=1,
            salt_len=16,
            hash_len=32,
            encoding="utf-8",
        )

    def hash(self, password: str) -> str:
        """Return an encoded PHC; never emit it in diagnostics."""
        return self._hasher.hash(password)

    def verify(self, encoded: str, password: str) -> bool:
        """Distinguish mismatch from resource/backend failure."""
        if len(encoded) > 512:
            raise ValueError("Invalid password encoding")
        parameters = extract_parameters(encoded)
        if (
            parameters.type,
            parameters.version,
            parameters.memory_cost,
            parameters.time_cost,
            parameters.parallelism,
            parameters.salt_len,
            parameters.hash_len,
        ) != (Type.ID, 19, 65536, 3, 1, 16, 32):
            raise ValueError("Invalid password profile")
        try:
            return self._hasher.verify(encoded, password)
        except VerifyMismatchError:
            return False


type Result = str | bool


@dataclass(eq=False, repr=False)
class _Job:
    work: Callable[[], Result] | None
    result: asyncio.Future[Result]
    expires: float
    timer: asyncio.TimerHandle = field(init=False)


class PasswordService:
    """Event-loop-owned bounded admission; never enqueue in the executor itself."""

    def __init__(self, hasher: Hasher | None = None) -> None:
        self._hasher = hasher if hasher is not None else ArgonHasher()
        self._executor = ThreadPoolExecutor(
            max_workers=2, thread_name_prefix="password"
        )
        self._pending: deque[_Job] = deque()
        self._running = 0
        self._closed = False
        self._closing: asyncio.Future[None] | None = None

    @property
    def running(self) -> int:
        """Count actual submitted futures, not live asyncio callers."""
        return self._running

    @property
    def waiting(self) -> int:
        """Count removable application waiters (never more than four)."""
        return len(self._pending)

    async def hash(self, password: str, *, deadline: float) -> str:
        """Hash before a caller's absolute monotonic deadline."""
        return cast(
            str, await self._submit(lambda: self._hasher.hash(password), deadline)
        )

    async def verify(self, encoded: str, password: str, *, deadline: float) -> bool:
        """Verify through the same admission budget as hash."""
        return cast(
            bool,
            await self._submit(
                lambda: self._hasher.verify(encoded, password), deadline
            ),
        )

    async def _submit(self, work: Callable[[], Result], deadline: float) -> Result:
        loop = asyncio.get_running_loop()
        if self._closed or deadline <= loop.time() or len(self._pending) >= 4:
            raise PasswordBusy()
        result: asyncio.Future[Result] = loop.create_future()
        job = _Job(work, result, min(loop.time() + 2, deadline))
        job.timer = loop.call_at(job.expires, self._expire, job)
        self._pending.append(job)
        self._pump()
        # The coroutine frame must not keep a second secret-bearing closure.
        del work
        try:
            async with asyncio.timeout_at(deadline):
                return await asyncio.shield(result)
        except TimeoutError:
            raise PasswordBusy() from None
        finally:
            self._remove(job)
            result.cancel()

    def _remove(self, job: _Job) -> None:
        if job in self._pending:
            self._pending.remove(job)
        job.work = None
        job.timer.cancel()

    def _expire(self, job: _Job) -> None:
        self._remove(job)
        job.result.set_exception(PasswordBusy())

    def _pump(self) -> None:
        loop = asyncio.get_running_loop()
        while self._pending and self._running < 2:
            job = self._pending[0]
            if loop.time() >= job.expires:
                self._expire(job)
                continue
            self._pending.popleft()
            job.timer.cancel()
            self._running += 1
            try:
                future = self._executor.submit(cast(Callable[[], Result], job.work))
            except Exception:
                self._running -= 1
                job.result.set_exception(PasswordUnavailable())
                continue
            finally:
                job.work = None

            def completed(
                done: Future[Result], result: asyncio.Future[Result] = job.result
            ) -> None:
                loop.call_soon_threadsafe(self._finished, done, result)

            future.add_done_callback(completed)

    def _finished(self, future: Future[Result], result: asyncio.Future[Result]) -> None:
        self._running -= 1
        try:
            value = future.result()
        except Exception:
            if not result.done():
                result.set_exception(PasswordUnavailable())
        else:
            if not result.done():
                result.set_result(value)
        self._pump()

    async def aclose(self) -> None:
        """Close admission, cancel pending secrets, and join threads off-loop."""
        if self._closing is None:
            self._closed = True
            while self._pending:
                job = self._pending[0]
                self._remove(job)
                job.result.cancel()
            loop = asyncio.get_running_loop()
            self._closing = loop.create_future()

            def join() -> None:
                self._executor.shutdown(wait=True, cancel_futures=True)
                loop.call_soon_threadsafe(self._closing_done)

            Thread(target=join, name="password-join").start()
        cancelled = False
        while not self._closing.done():
            try:
                await asyncio.shield(self._closing)
            except asyncio.CancelledError:
                cancelled = True
        if cancelled:
            raise asyncio.CancelledError()

    def _closing_done(self) -> None:
        cast(asyncio.Future[None], self._closing).set_result(None)

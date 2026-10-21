"""Typed test-only native barriers; never exported through HTTP dependencies."""

import asyncio
import threading
from collections.abc import Callable
from dataclasses import dataclass

from lexicona.auth.passwords import ArgonHasher, Hasher


@dataclass
class RateClock:
    value: float = 0.0

    def __call__(self) -> float:
        return self.value


class LoginHasher:
    def __init__(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.calls = 0
        self.started: asyncio.Queue[None] = asyncio.Queue()
        self.hold = False
        self.release = threading.Event()
        self.action: Callable[[], None] = lambda: None

    def verify(self, encoded: str, password: str) -> bool:
        self.calls += 1
        if self.hold:
            self.loop.call_soon_threadsafe(self.started.put_nowait, None)
            assert self.release.wait(5)
        matches = ArgonHasher().verify(encoded, password)
        self.action()
        return matches

    def typed(self) -> Hasher:
        return Hasher(ArgonHasher().hash, self.verify)

    async def wait_started(self) -> None:
        await asyncio.wait_for(self.started.get(), 3)

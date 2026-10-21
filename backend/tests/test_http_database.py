"""Auth DB admission shares a deadline and restores the foundation policy."""

import asyncio
from pathlib import Path

import pytest
from sqlalchemy import text
from test_auth_schema import migrate

from lexicona.database import Database


async def test_deadline_uow_bounds_busy_and_restores_connection(tmp_path: Path) -> None:
    path = tmp_path / "deadline.sqlite3"
    await asyncio.to_thread(migrate, path)
    db = Database(f"sqlite+aiosqlite:///{path}")
    try:
        async with db.unit_of_work(
            write=True, deadline=asyncio.get_running_loop().time() + 1
        ) as session:
            busy = await session.scalar(text("PRAGMA busy_timeout"))
            assert isinstance(busy, int) and 0 < busy <= 1000
            assert await session.scalar(text("PRAGMA synchronous")) == 2
        async with db.unit_of_work() as session:
            assert await session.scalar(text("PRAGMA busy_timeout")) == 5000
        with pytest.raises(TimeoutError):
            async with db.unit_of_work(write=True, deadline=0):
                pytest.fail("Expired admission must not enter a UoW")
    finally:
        await db.dispose()

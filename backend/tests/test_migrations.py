"""Exercise Alembic's online and offline entrypoints, not revision mocks."""

import asyncio
from io import StringIO
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import text

from lexicona.database import SCHEMA_REVISION, Database


async def test_online_upgrade_idempotence_and_downgrade(tmp_path: Path) -> None:
    config = Config("alembic.ini")
    url = f"sqlite+aiosqlite:///{tmp_path / 'migrate.sqlite3'}"
    config.set_main_option("sqlalchemy.url", url)
    database = Database(url)
    try:
        assert not await database.is_ready()
        await asyncio.to_thread(command.upgrade, config, "head")
        await asyncio.to_thread(command.upgrade, config, "head")
        assert await database.is_ready()
        async with database.unit_of_work() as session:
            assert (
                await session.scalar(text("SELECT version_num FROM alembic_version"))
                == SCHEMA_REVISION
            )
        await asyncio.to_thread(command.downgrade, config, "base")
        assert not await database.is_ready()
        await asyncio.to_thread(command.upgrade, config, "head")
        assert await database.is_ready()
    finally:
        await database.dispose()


def test_offline_upgrade_and_downgrade_sql() -> None:
    buffer = StringIO()
    config = Config("alembic.ini", output_buffer=buffer)
    config.set_main_option("sqlalchemy.url", "sqlite+aiosqlite:///unused.sqlite3")
    command.upgrade(config, "head", sql=True)
    sql = buffer.getvalue()
    assert "CREATE TABLE alembic_version" in sql
    assert SCHEMA_REVISION in sql
    buffer.seek(0)
    buffer.truncate()
    command.downgrade(config, "0001_foundation:base", sql=True)
    assert "DELETE FROM alembic_version" in buffer.getvalue()

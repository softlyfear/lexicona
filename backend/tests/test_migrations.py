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


async def test_future_upgrade_failure_rolls_back_ddl_savepoint_data_and_revision(
    tmp_path: Path,
) -> None:
    import shutil

    import pytest

    scripts = tmp_path / "migrations"
    shutil.copytree("migrations", scripts)
    revision = scripts / "versions" / "0002_probe.py"
    migration = """from alembic import op
import sqlalchemy as sa
revision = "0002_probe"
down_revision = "0002_auth_core"

def upgrade():
    op.create_table("upgrade_probe", sa.Column("id", sa.Integer(), primary_key=True))
    with op.get_bind().begin_nested():
        op.execute("INSERT INTO upgrade_probe VALUES (1)")
        op.execute("INSERT INTO retained VALUES (2)")
    raise RuntimeError("fixture abort after released savepoint")

def downgrade():
    op.drop_table("upgrade_probe")
"""
    revision.write_text(migration)
    config = Config("alembic.ini")
    config.set_main_option("script_location", str(scripts))
    url = f"sqlite+aiosqlite:///{tmp_path / 'upgrade.sqlite3'}"
    config.set_main_option("sqlalchemy.url", url)
    database = Database(url)
    try:
        await asyncio.to_thread(command.upgrade, config, SCHEMA_REVISION)
        async with database.unit_of_work(write=True) as session:
            await session.execute(
                text("CREATE TABLE retained (id INTEGER PRIMARY KEY)")
            )
            await session.execute(text("INSERT INTO retained VALUES (1)"))
        with pytest.raises(RuntimeError, match="fixture abort"):
            await asyncio.to_thread(command.upgrade, config, "head")
        assert await database.is_ready()
        async with database.unit_of_work() as session:
            assert (
                await session.execute(text("SELECT id FROM retained"))
            ).scalars().all() == [1]
            assert (
                await session.scalar(
                    text(
                        "SELECT count(*) FROM sqlite_master WHERE name='upgrade_probe'"
                    )
                )
                == 0
            )
        # Remove only the injected fault; rerun the same upgrade preserving data.
        revision.write_text(
            migration.replace(
                '    raise RuntimeError("fixture abort after released savepoint")\n', ""
            )
        )
        await asyncio.to_thread(command.upgrade, config, "head")
        async with database.unit_of_work() as session:
            assert (
                await session.scalar(text("SELECT version_num FROM alembic_version"))
                == "0002_probe"
            )
            assert (
                await session.execute(text("SELECT id FROM retained ORDER BY id"))
            ).scalars().all() == [1, 2]
            assert await session.scalar(text("SELECT id FROM upgrade_probe")) == 1
            assert await session.scalar(text("PRAGMA integrity_check")) == "ok"
            assert (await session.execute(text("PRAGMA foreign_key_check"))).all() == []
        await asyncio.to_thread(command.downgrade, config, SCHEMA_REVISION)
        assert await database.is_ready()
    finally:
        await database.dispose()

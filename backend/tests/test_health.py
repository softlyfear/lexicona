import asyncio
from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config
from asgi_lifespan import LifespanManager
from sqlalchemy import text

from lexicona.app import create_app
from lexicona.database import SCHEMA_REVISION, Database


async def test_explicit_migration_enables_readiness(tmp_path: Path) -> None:
    from lexicona.app import create_app

    url = f"sqlite+aiosqlite:///{tmp_path / 'app.sqlite3'}"
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", url)
    await asyncio.to_thread(command.upgrade, config, "head")
    app = create_app(url)
    async with LifespanManager(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}
    assert response.headers["cache-control"] == "no-store"


async def test_live_is_independent_of_schema(tmp_path: Path) -> None:
    from lexicona.app import create_app

    app = create_app(f"sqlite+aiosqlite:///{tmp_path / 'private' / 'app.sqlite3'}")
    async with LifespanManager(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "alive"}
    assert response.headers["cache-control"] == "no-store"


async def test_ready_requires_explicit_migration(tmp_path: Path) -> None:
    from lexicona.app import create_app

    app = create_app(f"sqlite+aiosqlite:///{tmp_path / 'app.sqlite3'}")
    async with LifespanManager(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json() == {
        "error": {"code": "not_ready", "message": "Service is not ready"}
    }
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "revisions", [[], ["old"], ["future"], [SCHEMA_REVISION, "other"]]
)
async def test_ready_rejects_any_schema_other_than_exact_head(
    tmp_path: Path, revisions: list[str]
) -> None:
    url = f"sqlite+aiosqlite:///{tmp_path / 'mismatched.sqlite3'}"
    database = Database(url)
    try:
        async with database.unit_of_work() as session:
            await session.execute(
                text("CREATE TABLE alembic_version (version_num TEXT)")
            )
            for revision in revisions:
                await session.execute(
                    text("INSERT INTO alembic_version VALUES (:revision)"),
                    {"revision": revision},
                )
    finally:
        await database.dispose()
    async with LifespanManager(app := create_app(url)):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json() == {
        "error": {"code": "not_ready", "message": "Service is not ready"}
    }
    assert response.headers["cache-control"] == "no-store"


async def test_unavailable_database_is_safe_and_liveness_survives(
    tmp_path: Path,
) -> None:
    # A directory cannot be opened as a SQLite file, even for a privileged process.
    url = f"sqlite+aiosqlite:///{tmp_path}"
    async with LifespanManager(app := create_app(url)):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            ready = await client.get("/api/v1/health/ready")
            live = await client.get("/api/v1/health/live")
    assert ready.status_code == 503
    assert ready.json() == {
        "error": {"code": "not_ready", "message": "Service is not ready"}
    }
    assert ready.headers["cache-control"] == "no-store"
    assert str(tmp_path) not in ready.text
    assert live.status_code == 200
    assert live.json() == {"status": "alive"}


async def assert_safe_health(client: httpx.AsyncClient, ready_status: int) -> None:
    """Assert exact, private health responses on the same running ASGI app."""
    live = await client.get("/api/v1/health/live")
    assert live.status_code == 200
    assert live.json() == {"status": "alive"}
    assert live.headers["cache-control"] == "no-store"
    ready = await client.get("/api/v1/health/ready")
    assert ready.status_code == ready_status
    assert ready.headers["cache-control"] == "no-store"
    assert ready.json() == (
        {"status": "ready"}
        if ready_status == 200
        else {"error": {"code": "not_ready", "message": "Service is not ready"}}
    )


@pytest.mark.parametrize("nested", [False, True])
async def test_parent_file_is_safe_and_recovers_without_app_restart(
    tmp_path: Path, nested: bool
) -> None:
    blocked = tmp_path / "private-parent"
    blocked.write_text("not a directory", encoding="utf-8")
    directory = blocked / "nested" if nested else blocked
    url = f"sqlite+aiosqlite:///{directory / 'app.sqlite3'}"
    async with LifespanManager(app := create_app(url)):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await assert_safe_health(client, 503)
            await assert_safe_health(client, 503)
            assert blocked.read_text() == "not a directory"
            blocked.unlink()
            # Recovery creates the private directory, but never the schema.
            await assert_safe_health(client, 503)
            assert directory.is_dir()
            config = Config("alembic.ini")
            config.set_main_option("sqlalchemy.url", url)
            await asyncio.to_thread(command.upgrade, config, "head")
            await assert_safe_health(client, 200)


async def test_directory_permission_denied_is_safe_and_recovers(
    tmp_path: Path,
) -> None:
    import os

    blocked = tmp_path / "private-parent"
    blocked.mkdir(mode=0o500)
    try:
        if os.access(blocked, os.W_OK):
            pytest.skip("Process bypasses directory permissions")
        directory = blocked / "nested"
        url = f"sqlite+aiosqlite:///{directory / 'app.sqlite3'}"
        async with LifespanManager(app := create_app(url)):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                await assert_safe_health(client, 503)
                assert not directory.exists()
                blocked.chmod(0o700)
                await assert_safe_health(client, 503)
                config = Config("alembic.ini")
                config.set_main_option("sqlalchemy.url", url)
                await asyncio.to_thread(command.upgrade, config, "head")
                await assert_safe_health(client, 200)
    finally:
        blocked.chmod(0o700)


async def test_default_app_does_not_migrate_on_startup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("LEXICONA_DATABASE_URL", raising=False)
    async with LifespanManager(app := create_app()):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/health/ready")
    assert response.status_code == 503
    assert (tmp_path / "data" / "lexicona.sqlite3").is_file()


async def test_environment_url_is_shared_by_migrations_and_app(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(
        "LEXICONA_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'environment.sqlite3'}",
    )
    await asyncio.to_thread(command.upgrade, Config("alembic.ini"), "head")
    async with LifespanManager(app := create_app()):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}

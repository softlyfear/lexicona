from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from httpx import ASGITransport, AsyncClient

from lexicona.cli import main as admin
from lexicona.config import Settings
from lexicona.main import create_app

BACKEND = Path(__file__).parent.parent


def alembic_config(url: str) -> Config:
    config = Config(BACKEND / "alembic.ini")
    config.set_main_option("sqlalchemy.url", url)
    return config


def test_migrations_match_models(tmp_path: Path) -> None:
    config = alembic_config(f"sqlite+aiosqlite:///{tmp_path}/m.db")
    command.upgrade(config, "head")
    command.check(config)  # raises if models drifted from migrations
    command.downgrade(config, "base")


async def test_health(anon: AsyncClient) -> None:
    response = await anon.get("/api/health")
    assert response.json() == {"status": "ok"}


async def test_spa_fallback(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<!doctype html>app")
    (tmp_path / "app.js").write_text("js")
    app = create_app(
        Settings(database_url=f"sqlite+aiosqlite:///{tmp_path}/s.db", static_dir=tmp_path)
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get("/app.js")).text == "js"
        assert (await client.get("/training")).text == "<!doctype html>app"
        assert (await client.get("/api/nope")).status_code == 404


def test_admin_cli(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    url = f"sqlite+aiosqlite:///{tmp_path}/cli.db"
    command.upgrade(alembic_config(url), "head")
    monkeypatch.setenv("LEXICONA_DATABASE_URL", url)
    monkeypatch.setattr("getpass.getpass", lambda _prompt: "long enough password")

    admin(["create-user", "alice", "--admin"])
    admin(["set-password", "alice"])
    admin(["list-users"])
    assert capsys.readouterr().out.splitlines() == [
        "Created 'alice'.",
        "Password updated for 'alice'.",
        "alice (admin)",
    ]
    with pytest.raises(SystemExit):
        admin(["create-user", "alice"])
    with pytest.raises(SystemExit):
        admin(["set-password", "ghost"])

    monkeypatch.setattr("getpass.getpass", lambda _prompt: "short")
    with pytest.raises(SystemExit):
        admin(["create-user", "bob"])

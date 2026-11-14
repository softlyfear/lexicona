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
        Settings(
            _env_file=None,
            database_url=f"sqlite+aiosqlite:///{tmp_path}/s.db",
            static_dir=tmp_path,
            tts_dir=tmp_path / "tts",
        )
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


def test_tags_upgrade_and_guarded_downgrade(tmp_path: Path) -> None:
    import sqlite3

    path = tmp_path / "tags-migration.db"
    config = alembic_config(f"sqlite+aiosqlite:///{path}")
    command.upgrade(config, "d90b58c2a113")
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO users (id, login, password_hash, is_admin, difficulty, created_at) "
            "VALUES ('u', 'alice', 'hash', 0, 'medium', '2020-01-01')"
        )
        conn.execute(
            "INSERT INTO words (id, owner_id, headword, normalized_headword, progress, "
            "is_excluded, training_version, content_version, created_at, updated_at) "
            "VALUES ('w', 'u', 'word', 'word', 123, 1, 3, 4, '2020-01-01', '2020-01-01')"
        )
        conn.execute(
            "INSERT INTO word_translations (id, word_id, position, text, normalized_text) "
            "VALUES ('tr', 'w', 0, 'слово', 'слово')"
        )
        conn.execute(
            "INSERT INTO training_sessions (id, owner_id, mode, direction, difficulty, created_at) "
            "VALUES ('s', 'u', 'choice', 'en_ru', 'medium', '2020-01-01')"
        )
        conn.execute(
            "INSERT INTO training_items (id, session_id, word_id, word_content_version, "
            "word_training_version, position, prompt, options, correct_option) "
            "VALUES ('i', 's', 'w', 4, 3, 0, 'word', '[\"слово\", \"другое\"]', 0)"
        )
        queries = (
            "SELECT * FROM users",
            "SELECT * FROM words",
            "SELECT * FROM word_translations",
            "SELECT * FROM training_sessions",
            "SELECT * FROM training_items",
        )
        before = [conn.execute(query).fetchall() for query in queries]
    command.upgrade(config, "a71b3c9d8201")
    with sqlite3.connect(path) as conn:
        assert [conn.execute(query).fetchall() for query in queries] == before
        assert conn.execute("SELECT * FROM tags").fetchall() == []
        assert conn.execute("SELECT * FROM word_tags").fetchall() == []
        assert conn.execute(
            "SELECT progress, is_excluded, training_version, content_version FROM words"
        ).fetchone() == (123, 1, 3, 4)
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        conn.execute("INSERT INTO tags VALUES ('t', 'u', 'Name', 'name')")
        conn.execute("INSERT INTO word_tags VALUES ('u', 'w', 't')")
    with pytest.raises(RuntimeError, match="Cannot downgrade"):
        command.downgrade(config, "d90b58c2a113")
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT version_num FROM alembic_version").fetchone() == (
            "a71b3c9d8201",
        )
        assert conn.execute("SELECT * FROM word_tags").fetchall() == [("u", "w", "t")]
        conn.execute("DELETE FROM word_tags")
        conn.execute("DELETE FROM tags")
    command.downgrade(config, "d90b58c2a113")


def test_learned_mark_survives_upgrade_and_blocks_downgrade(tmp_path: Path) -> None:
    import sqlite3

    path = tmp_path / "learned.db"
    config = alembic_config(f"sqlite+aiosqlite:///{path}")
    command.upgrade(config, "e65adf970121")
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO users (id, login, password_hash, is_admin, difficulty, created_at) "
            "VALUES ('u', 'alice', 'hash', 0, 'medium', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO words (id, owner_id, headword, normalized_headword, progress, "
            "content_version, created_at, updated_at) "
            "VALUES ('w', 'u', 'cat', 'cat', 37, 1, '2026-01-01', '2026-01-01')"
        )
    command.upgrade(config, "head")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT progress, is_learned FROM words").fetchone() == (37, 0)
        db.execute("UPDATE words SET is_learned = 1")
    with pytest.raises(RuntimeError, match="learned words"):
        command.downgrade(config, "e65adf970121")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT progress, is_learned FROM words").fetchone() == (37, 1)
        db.execute("UPDATE words SET is_learned = 0")
    command.downgrade(config, "e65adf970121")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT progress FROM words").fetchone() == (37,)
        columns = [row[1] for row in db.execute("PRAGMA table_info(words)")]
        assert "is_learned" not in columns


def test_user_preferences_migration_refuses_data_loss(tmp_path: Path) -> None:
    import json
    import sqlite3

    path = tmp_path / "preferences.db"
    config = alembic_config(f"sqlite+aiosqlite:///{path}")
    command.upgrade(config, "a4c7e2b91d08")
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO users (id, login, password_hash, is_admin, difficulty, created_at) "
            "VALUES ('u', 'alice', 'hash', 0, 'medium', '2026-01-01')"
        )
    command.upgrade(config, "head")
    with sqlite3.connect(path) as db:
        columns = [row[1] for row in db.execute("PRAGMA table_info(users)")]
        assert "preferences" in columns
        assert "preferences_revision" in columns
        assert db.execute(
            "SELECT login, preferences, preferences_revision FROM users"
        ).fetchone() == ("alice", None, 0)
        db.execute(
            "INSERT INTO users (id, login, password_hash, is_admin, difficulty, created_at) "
            "VALUES ('u2', 'bob', 'hash', 0, 'easy', '2026-01-02')"
        )
        assert db.execute(
            "SELECT preferences, preferences_revision FROM users WHERE id = 'u2'"
        ).fetchone() == (None, 0)
        db.execute("UPDATE users SET preferences = ?", (json.dumps({"speech": {"rate": 1}}),))
    with pytest.raises(RuntimeError, match="user preferences"):
        command.downgrade(config, "a4c7e2b91d08")
    with sqlite3.connect(path) as db:
        assert json.loads(db.execute("SELECT preferences FROM users").fetchone()[0])["speech"] == {
            "rate": 1
        }
        db.execute("UPDATE users SET preferences = '{}'")
    command.downgrade(config, "a4c7e2b91d08")
    with sqlite3.connect(path) as db:
        columns = [row[1] for row in db.execute("PRAGMA table_info(users)")]
        assert "preferences" not in columns
        assert "preferences_revision" not in columns
        assert db.execute("SELECT login, difficulty FROM users WHERE id = 'u'").fetchone() == (
            "alice",
            "medium",
        )


def test_session_include_learned_defaults_off_and_blocks_downgrade(tmp_path: Path) -> None:
    import sqlite3

    path = tmp_path / "include-learned.db"
    config = alembic_config(f"sqlite+aiosqlite:///{path}")
    command.upgrade(config, "b7d4e1a83c90")
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO users (id, login, password_hash, is_admin, difficulty, created_at) "
            "VALUES ('u', 'alice', 'hash', 0, 'medium', '2026-01-01')"
        )
        db.execute(
            "INSERT INTO training_sessions (id, owner_id, mode, direction, difficulty, created_at) "
            "VALUES ('s', 'u', 'input', 'en_ru', 'medium', '2026-01-01')"
        )
    command.upgrade(config, "head")
    with sqlite3.connect(path) as db:
        assert db.execute(
            "SELECT mode, direction, include_learned FROM training_sessions WHERE id = 's'"
        ).fetchone() == ("input", "en_ru", 0)
        db.execute(
            "INSERT INTO training_sessions (id, owner_id, mode, direction, difficulty, created_at) "
            "VALUES ('later', 'u', 'choice', 'en_ru', 'medium', '2026-01-02')"
        )
        assert db.execute(
            "SELECT include_learned FROM training_sessions WHERE id = 'later'"
        ).fetchone() == (0,)
        db.execute("UPDATE training_sessions SET include_learned = 1 WHERE id = 's'")
    with pytest.raises(RuntimeError, match="includes learned words"):
        command.downgrade(config, "b7d4e1a83c90")
    with sqlite3.connect(path) as db:
        assert db.execute(
            "SELECT include_learned FROM training_sessions WHERE id = 's'"
        ).fetchone() == (1,)
        db.execute("UPDATE training_sessions SET include_learned = 0")
    command.downgrade(config, "b7d4e1a83c90")
    with sqlite3.connect(path) as db:
        columns = [row[1] for row in db.execute("PRAGMA table_info(training_sessions)")]
        assert "include_learned" not in columns
        assert db.execute("SELECT mode FROM training_sessions WHERE id = 's'").fetchone() == (
            "input",
        )


def test_source_refs_migration_refuses_data_loss(tmp_path: Path) -> None:
    import json
    import sqlite3

    path = tmp_path / "refs.db"
    config = alembic_config(f"sqlite+aiosqlite:///{path}")
    command.upgrade(config, "a71b3c9d8201")
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO users (id, login, password_hash, is_admin, difficulty, created_at) "
            "VALUES ('u', 'a', 'h', 0, 'medium', '2020-01-01')"
        )
        db.execute(
            "INSERT INTO words (id, owner_id, headword, normalized_headword, progress, "
            "is_excluded, training_version, content_version, created_at, updated_at) "
            "VALUES ('w', 'u', 'cat', 'cat', 12, 0, 1, 2, '2020-01-01', '2020-01-01')"
        )
    command.upgrade(config, "head")
    ref = [
        {
            "source_id": "freedict-wikdict-eng-rus-2025.11.23",
            "entry_id": 1,
            "field": "translation",
            "value": "кот",
        }
    ]
    with sqlite3.connect(path) as db:
        assert db.execute(
            "SELECT headword, progress, content_version, source_refs FROM words"
        ).fetchone() == ("cat", 12, 2, None)
        db.execute("UPDATE words SET source_refs = ?", (json.dumps(ref),))
    with pytest.raises(RuntimeError, match="source refs"):
        command.downgrade(config, "a71b3c9d8201")
    with sqlite3.connect(path) as db:
        assert json.loads(db.execute("SELECT source_refs FROM words").fetchone()[0]) == ref
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        db.execute("UPDATE words SET source_refs = '[]'")
    command.downgrade(config, "a71b3c9d8201")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT headword, progress, content_version FROM words").fetchone() == (
            "cat",
            12,
            2,
        )

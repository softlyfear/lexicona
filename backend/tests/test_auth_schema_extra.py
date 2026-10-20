"""Physical migration rollback, FK/index/default details and constraint boundaries."""

import sqlite3
from collections.abc import Callable
from contextlib import closing
from pathlib import Path
from typing import cast
from uuid import uuid4

import pytest
from alembic import command
from alembic.operations import Operations
from test_auth_schema import insert_row, migrate, valid_user


def test_auth_upgrade_partial_ddl_rolls_back_to_original_0001(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "ddl-rollback.sqlite3"
    config = migrate(path, "0001_foundation")
    original = cast(Callable[..., object], Operations.execute)

    def execute(self: Operations, statement: object, **kwargs: object) -> None:
        if "CREATE TABLE auth_sessions" in str(statement):
            raise RuntimeError("fixture abort auth upgrade")
        original(self, statement, **kwargs)

    with monkeypatch.context() as patcher:
        patcher.setattr(Operations, "execute", execute)
        with pytest.raises(RuntimeError, match="fixture abort auth upgrade"):
            command.upgrade(config, "head")
    with closing(sqlite3.connect(path)) as c:
        assert c.execute("SELECT version_num FROM alembic_version").fetchall() == [
            ("0001_foundation",)
        ]
        assert c.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall() == [("alembic_version",)]
    command.upgrade(config, "head")


def test_physical_defaults_fk_indexes_and_updates(tmp_path: Path) -> None:
    path = tmp_path / "details.sqlite3"
    migrate(path)
    with closing(sqlite3.connect(path)) as c:
        c.execute("PRAGMA foreign_keys=ON")
        user = valid_user()
        for field in ["role", "is_active", "version"]:
            del user[field]
        insert_row(c, "users", user)
        assert c.execute("SELECT role,is_active,version FROM users").fetchone() == (
            "user",
            1,
            1,
        )
        insert_row(
            c, "user_settings", dict(user_id=user["id"], created_at=1, updated_at=1)
        )
        invalid_settings: dict[str, list[object]] = {
            "timezone": ["", "x" * 65],
            "theme": ["gold"],
            "daily_goal": [0, 1001, 1.5],
            "speech_rate": [0.5],
            "english_locale": ["ru-RU"],
            "version": [0],
            "updated_at": [0],
        }
        for field, values in invalid_settings.items():
            for value in values:
                with pytest.raises(sqlite3.IntegrityError):
                    c.execute(f"UPDATE user_settings SET {field}=?", (value,))
        session = dict(
            id=str(uuid4()),
            user_id=user["id"],
            token_hash=bytes(32),
            csrf_token="A" * 43,
            created_at=1,
            last_seen_at=1,
            expires_at=604800000001,
            absolute_expires_at=2592000000001,
            revoked_at=None,
        )
        insert_row(c, "auth_sessions", session)
        for field, value in [
            ("last_seen_at", 0),
            ("expires_at", 1),
            ("expires_at", 604800000002),
            ("absolute_expires_at", 2592000000002),
            ("csrf_token", "A" * 43 + "\x00"),
            ("id", str(uuid4()) + "\x00"),
            ("revoked_at", -1),
            ("user_id", str(uuid4())),
        ]:
            with pytest.raises(sqlite3.IntegrityError):
                c.execute(f"UPDATE auth_sessions SET {field}=?", (value,))
        fks = {row[3]: row[6] for row in c.execute("PRAGMA foreign_key_list(invites)")}
        assert fks == {"used_by": "SET NULL", "created_by": "SET NULL"}
        assert {
            row[3]: row[6]
            for row in c.execute("PRAGMA foreign_key_list(auth_sessions)")
        } == {"user_id": "CASCADE"}
        assert [
            (r[2], r[3])
            for r in c.execute("PRAGMA index_xinfo(ix_invites_created_id)")
            if r[5]
        ] == [("created_at", 1), ("id", 1)]
        assert [
            (r[2], r[3])
            for r in c.execute(
                "PRAGMA index_xinfo(ix_sessions_user_revoked_created_id)"
            )
            if r[5]
        ] == [("user_id", 0), ("revoked_at", 0), ("created_at", 0), ("id", 0)]
        for table in ["users", "user_settings", "auth_sessions", "invites"]:
            for row in c.execute(f"PRAGMA table_info({table})"):
                if row[1] in {
                    "id",
                    "created_at",
                    "updated_at",
                    "token_hash",
                    "csrf_token",
                    "expires_at",
                    "absolute_expires_at",
                    "last_seen_at",
                }:
                    assert row[4] is None
        c.execute("DELETE FROM users")
        assert c.execute("SELECT count(*) FROM auth_sessions").fetchone() == (0,)
        assert c.execute("SELECT count(*) FROM user_settings").fetchone() == (0,)
        assert c.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert c.execute("PRAGMA foreign_key_check").fetchall() == []

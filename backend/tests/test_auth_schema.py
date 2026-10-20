"""Real file-backed WAL migrations and contract constraints."""

import sqlite3
from collections.abc import Mapping
from contextlib import closing
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config

HEAD = "0002_auth_core"
TABLES = {"users", "user_settings", "auth_sessions", "invites"}


def migrate(path: Path, revision: str = "head") -> Config:
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite+aiosqlite:///{path}")
    command.upgrade(config, revision)
    return config


def test_auth_schema_fresh_upgrade_and_downgrade(tmp_path: Path) -> None:
    for initial in ["base", "0001_foundation"]:
        path = tmp_path / f"{initial}.sqlite3"
        config = migrate(path, initial)
        command.upgrade(config, "head")
        with closing(sqlite3.connect(path)) as connection:
            names = {
                r[0]
                for r in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            assert names == TABLES | {"alembic_version"}
            assert connection.execute(
                "SELECT version_num FROM alembic_version"
            ).fetchall() == [(HEAD,)]
            assert connection.execute("PRAGMA journal_mode").fetchone() == ("wal",)
            assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        command.downgrade(config, "0001_foundation")
        with closing(sqlite3.connect(path)) as connection:
            assert connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall() == [("alembic_version",)]
        command.upgrade(config, "head")


def valid_user() -> dict[str, object]:
    from uuid import uuid4

    return dict(
        id=str(uuid4()),
        login="admin",
        display_name="Имя",
        password_hash="PHC",
        role="admin",
        is_active=1,
        version=1,
        created_at=1,
        updated_at=1,
    )


def insert_row(
    connection: sqlite3.Connection, table: str, values: Mapping[str, object]
) -> None:
    columns = ",".join(values)
    parameters = ",".join("?" for _ in values)
    connection.execute(
        f"INSERT INTO {table} ({columns}) VALUES ({parameters})", list(values.values())
    )


def test_contract_constraints_defaults_indexes_and_delete_policies(
    tmp_path: Path,
) -> None:
    from uuid import uuid4

    path = tmp_path / "constraints.sqlite3"
    migrate(path)
    with closing(sqlite3.connect(path)) as c:
        c.execute("PRAGMA foreign_keys=ON")
        user = valid_user()
        insert_row(c, "users", user)
        insert_row(
            c, "user_settings", dict(user_id=user["id"], created_at=1, updated_at=1)
        )
        assert c.execute(
            "SELECT timezone,theme,daily_goal,speech_rate,"
            "english_locale,version FROM user_settings"
        ).fetchone() == ("UTC", "dark", 10, 1.0, "en-US", 1)
        pre = dict(
            id=str(uuid4()),
            user_id=None,
            token_hash=bytes(32),
            csrf_token="A" * 43,
            created_at=1,
            last_seen_at=1,
            expires_at=1800000001,
            absolute_expires_at=1800000001,
            revoked_at=None,
        )
        insert_row(c, "auth_sessions", pre)
        invite = dict(
            id=str(uuid4()),
            token_hash=bytes(32),
            created_by=user["id"],
            created_at=1,
            expires_at=259200000001,
            used_at=2,
            revoked_at=None,
            used_by=user["id"],
            version=1,
        )
        insert_row(c, "invites", invite)
        cases: list[tuple[str, Mapping[str, object], Mapping[str, object]]] = [
            ("users", user, {"login": "ADMIN"}),
            ("users", user, {"login": "abc\x00suffix"}),
            ("users", user, {"login": "ab-"}),
            ("users", user, {"login": "ab\n"}),
            ("users", user, {"login": "aa"}),
            ("users", user, {"display_name": ""}),
            ("users", user, {"password_hash": ""}),
            ("users", user, {"role": "owner"}),
            ("users", user, {"is_active": 2}),
            ("users", user, {"version": 0}),
            ("users", user, {"created_at": -1}),
            ("users", user, {"updated_at": 0}),
            ("users", user, {"created_at": 1.5}),
            ("users", user, {"id": "a" * 36}),
            ("users", user, {"id": str(uuid4()).upper()}),
            (
                "user_settings",
                dict(user_id=user["id"], created_at=1, updated_at=1),
                {"theme": "gold"},
            ),
            ("auth_sessions", pre, {"token_hash": bytes(31)}),
            ("auth_sessions", pre, {"token_hash": "A" * 32}),
            ("auth_sessions", pre, {"csrf_token": "A" * 42 + "B"}),
            ("auth_sessions", pre, {"last_seen_at": 2}),
            ("auth_sessions", pre, {"expires_at": 1800000000}),
            ("auth_sessions", pre, {"revoked_at": 0}),
            ("invites", invite, {"used_at": 2, "revoked_at": 3}),
            ("invites", invite, {"used_at": None}),
            ("invites", invite, {"used_at": 259200000001}),
            ("invites", invite, {"expires_at": 259200000002}),
        ]
        for table, baseline, invalid in cases:
            bad = dict(baseline) | dict(invalid)
            if table != "user_settings":
                if "id" not in invalid:
                    bad["id"] = str(uuid4())
                if table == "users" and "login" not in invalid:
                    bad["login"] = "another"
                elif table != "users" and "token_hash" not in invalid:
                    bad["token_hash"] = b"B" * 32
            with pytest.raises(sqlite3.IntegrityError):
                if table == "user_settings":
                    c.execute("UPDATE user_settings SET theme='gold'")
                else:
                    insert_row(c, table, bad)
        indexes = {
            t: {
                r[1]
                for r in c.execute(f"PRAGMA index_list({t})")
                if not r[1].startswith("sqlite_autoindex")
            }
            for t in TABLES
        }
        assert indexes == {
            "users": set(),
            "user_settings": set(),
            "auth_sessions": {
                "ix_sessions_user_revoked_created_id",
                "ix_sessions_expires_id",
            },
            "invites": {
                "ix_invites_created_id",
                "ix_invites_expires_id",
                "ix_invites_created_by",
                "ix_invites_used_by",
            },
        }
        c.execute("DELETE FROM users")
        assert c.execute("SELECT count(*) FROM user_settings").fetchone() == (0,)
        assert c.execute(
            "SELECT used_at,used_by,created_by FROM invites"
        ).fetchone() == (2, None, None)
        assert c.execute("PRAGMA foreign_key_check").fetchall() == []
        assert c.execute("PRAGMA integrity_check").fetchone() == ("ok",)

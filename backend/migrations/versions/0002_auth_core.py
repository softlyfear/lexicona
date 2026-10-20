"""Four bounded auth contract tables; immutable after publication.

Revision ID: 0002_auth_core
Revises: 0001_foundation
"""

from alembic import op

revision: str = "0002_auth_core"
down_revision: str = "0001_foundation"
branch_labels: tuple[str, ...] | None = None
depends_on: tuple[str, ...] | None = None


def upgrade() -> None:
    """Create only users, settings, sessions and invites with local invariants."""
    op.execute(
        """CREATE TABLE users (
        id TEXT NOT NULL PRIMARY KEY
            CHECK (length(id)=36
            AND length(CAST(id AS BLOB))=36
            AND substr(id,9,1)='-'
            AND substr(id,14,1)='-'
            AND substr(id,19,1)='-'
            AND substr(id,24,1)='-'
            AND length(replace(id,'-',''))=32
            AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'
            AND substr(id,15,1)='4'
            AND substr(id,20,1) IN ('8','9','a','b')),
        login TEXT NOT NULL COLLATE BINARY UNIQUE
            CHECK (length(login) BETWEEN 3
            AND 32
            AND length(CAST(login AS BLOB))=length(login)
            AND login NOT GLOB '*[^a-z0-9_]*'),
        display_name TEXT NOT NULL
            CHECK (length(display_name) BETWEEN 1
            AND 80),
        password_hash TEXT NOT NULL
            CHECK (length(password_hash) BETWEEN 1
            AND 512),
        role TEXT NOT NULL DEFAULT 'user'
            CHECK (role IN ('user','admin')),
        is_active INTEGER NOT NULL DEFAULT 1
            CHECK (typeof(is_active)='integer'
            AND is_active IN (0,1)),
        version INTEGER NOT NULL DEFAULT 1
            CHECK (typeof(version)='integer'
            AND version>=1),
        created_at INTEGER NOT NULL
            CHECK (typeof(created_at)='integer'
            AND created_at>=0),
        updated_at INTEGER NOT NULL
            CHECK (typeof(updated_at)='integer'
            AND updated_at>=0),

            CHECK (updated_at>=created_at)
    )"""
    )
    op.execute(
        """CREATE TABLE user_settings (
        user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        timezone TEXT NOT NULL DEFAULT 'UTC'
            CHECK (length(timezone) BETWEEN 1
            AND 64),
        theme TEXT NOT NULL DEFAULT 'dark'
            CHECK (theme IN ('light','dark','system')),
        daily_goal INTEGER NOT NULL DEFAULT 10
            CHECK (typeof(daily_goal)='integer'
            AND daily_goal BETWEEN 1
            AND 1000),
        speech_rate REAL NOT NULL DEFAULT 1.0
            CHECK (speech_rate IN (1.0,0.75)),
        english_locale TEXT NOT NULL DEFAULT 'en-US'
            CHECK (english_locale IN ('en-US','en-GB')),
        version INTEGER NOT NULL DEFAULT 1
            CHECK (typeof(version)='integer'
            AND version>=1),
        created_at INTEGER NOT NULL
            CHECK (typeof(created_at)='integer'
            AND created_at>=0),
        updated_at INTEGER NOT NULL
            CHECK (typeof(updated_at)='integer'
            AND updated_at>=0),

            CHECK (updated_at>=created_at)
    )"""
    )
    op.execute(
        """CREATE TABLE auth_sessions (
        id TEXT NOT NULL PRIMARY KEY
            CHECK (length(id)=36
            AND length(CAST(id AS BLOB))=36
            AND substr(id,9,1)='-'
            AND substr(id,14,1)='-'
            AND substr(id,19,1)='-'
            AND substr(id,24,1)='-'
            AND length(replace(id,'-',''))=32
            AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'
            AND substr(id,15,1)='4'
            AND substr(id,20,1) IN ('8','9','a','b')),
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        token_hash BLOB NOT NULL UNIQUE
            CHECK (typeof(token_hash)='blob'
            AND length(token_hash)=32),
        csrf_token TEXT NOT NULL
            CHECK (length(csrf_token)=43
            AND length(CAST(csrf_token AS BLOB))=43
            AND csrf_token NOT GLOB '*[^A-Za-z0-9_-]*'
            AND substr(csrf_token,43,1) GLOB '[AEIMQUYcgkosw048]'),
        created_at INTEGER NOT NULL
            CHECK (typeof(created_at)='integer'
            AND created_at>=0),
        last_seen_at INTEGER NOT NULL
            CHECK (typeof(last_seen_at)='integer'
            AND last_seen_at>=0),
        expires_at INTEGER NOT NULL
            CHECK (typeof(expires_at)='integer'
            AND expires_at>=0),
        absolute_expires_at INTEGER NOT NULL
            CHECK (typeof(absolute_expires_at)='integer'
            AND absolute_expires_at>=0),
        revoked_at INTEGER
            CHECK (revoked_at IS NULL
            OR (typeof(revoked_at)='integer'
            AND revoked_at>=0)),

            CHECK (last_seen_at>=created_at
            AND expires_at>created_at
            AND absolute_expires_at>=expires_at
            AND last_seen_at<expires_at),

            CHECK (revoked_at IS NULL
            OR revoked_at>=created_at),

            CHECK (user_id IS NOT NULL
            OR (last_seen_at=created_at
            AND expires_at=absolute_expires_at
            AND absolute_expires_at-created_at=1800000000)),

            CHECK (user_id IS NULL
            OR (absolute_expires_at-created_at=2592000000000
            AND expires_at<=last_seen_at+604800000000))
    )"""
    )
    op.execute(
        """CREATE TABLE invites (
        id TEXT NOT NULL PRIMARY KEY
            CHECK (length(id)=36
            AND length(CAST(id AS BLOB))=36
            AND substr(id,9,1)='-'
            AND substr(id,14,1)='-'
            AND substr(id,19,1)='-'
            AND substr(id,24,1)='-'
            AND length(replace(id,'-',''))=32
            AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'
            AND substr(id,15,1)='4'
            AND substr(id,20,1) IN ('8','9','a','b')),
        token_hash BLOB NOT NULL UNIQUE
            CHECK (typeof(token_hash)='blob'
            AND length(token_hash)=32),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
            CHECK (typeof(created_at)='integer'
            AND created_at>=0),
        expires_at INTEGER NOT NULL
            CHECK (typeof(expires_at)='integer'
            AND expires_at>=0),
        used_at INTEGER
            CHECK (used_at IS NULL
            OR (typeof(used_at)='integer'
            AND used_at>=0)),
        revoked_at INTEGER
            CHECK (revoked_at IS NULL
            OR (typeof(revoked_at)='integer'
            AND revoked_at>=0)),
        used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1
            CHECK (typeof(version)='integer'
            AND version>=1),

            CHECK (expires_at-created_at=259200000000),

            CHECK (used_at IS NULL
            OR revoked_at IS NULL),

            CHECK (used_by IS NULL
            OR used_at IS NOT NULL),

            CHECK (used_at IS NULL
            OR (used_at>=created_at
            AND used_at<expires_at)),

            CHECK (revoked_at IS NULL
            OR revoked_at>=created_at)
    )"""
    )
    op.execute(
        "CREATE INDEX ix_sessions_user_revoked_created_id "
        "ON auth_sessions(user_id,revoked_at,created_at,id)"
    )
    op.execute(
        """CREATE INDEX ix_sessions_expires_id ON auth_sessions(expires_at,id)"""
    )
    op.execute(
        """CREATE INDEX ix_invites_created_id ON invites(created_at DESC,id DESC)"""
    )
    op.execute("""CREATE INDEX ix_invites_expires_id ON invites(expires_at,id)""")
    op.execute("""CREATE INDEX ix_invites_created_by ON invites(created_by)""")
    op.execute("""CREATE INDEX ix_invites_used_by ON invites(used_by)""")


def downgrade() -> None:
    """Drop dependent tables before users; the foundation revision is unchanged."""
    op.drop_table("invites")
    op.drop_table("auth_sessions")
    op.drop_table("user_settings")
    op.drop_table("users")

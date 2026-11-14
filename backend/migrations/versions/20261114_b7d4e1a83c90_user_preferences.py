"""Store training and speech choices on the account.

Revision ID: b7d4e1a83c90
Revises: a4c7e2b91d08
"""

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7d4e1a83c90"
down_revision: str | Sequence[str] | None = "a4c7e2b91d08"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("preferences", sa.JSON(), nullable=True))
    op.add_column(
        "users",
        sa.Column("preferences_revision", sa.Integer(), nullable=False, server_default="0"),
    )


def _occupied(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, bytes):
        value = value.decode()
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return True
    return value not in (None, {})


def downgrade() -> None:
    rows = op.get_bind().execute(sa.text("SELECT preferences FROM users")).scalars()
    if any(_occupied(value) for value in rows):
        raise RuntimeError("Cannot downgrade while user preferences exist")
    op.drop_column("users", "preferences")
    op.drop_column("users", "preferences_revision")

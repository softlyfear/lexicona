"""Add owner-scoped word tags.

Revision ID: a71b3c9d8201
Revises: d90b58c2a113
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a71b3c9d8201"
down_revision: str | Sequence[str] | None = "d90b58c2a113"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("ix_words_owner_id_id", "words", ["owner_id", "id"], unique=True)
    op.create_table(
        "tags",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column(
            "owner_id", sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("normalized_name", sa.Text(), nullable=False),
        sa.UniqueConstraint("owner_id", "normalized_name"),
        sa.UniqueConstraint("owner_id", "id"),
    )
    op.create_table(
        "word_tags",
        sa.Column("owner_id", sa.String(32), primary_key=True),
        sa.Column("word_id", sa.String(32), primary_key=True),
        sa.Column("tag_id", sa.String(32), primary_key=True),
        sa.ForeignKeyConstraint(
            ["owner_id", "word_id"], ["words.owner_id", "words.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["owner_id", "tag_id"], ["tags.owner_id", "tags.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint("word_id", "tag_id"),
    )


def downgrade() -> None:
    connection = op.get_bind()
    if connection.execute(
        sa.text("SELECT EXISTS(SELECT 1 FROM tags) OR EXISTS(SELECT 1 FROM word_tags)")
    ).scalar_one():
        raise RuntimeError("Cannot downgrade while tags or word tag assignments exist")
    op.drop_table("word_tags")
    op.drop_table("tags")
    op.drop_index("ix_words_owner_id_id", table_name="words")

"""Add the per-word review schedule and session progress snapshots.

Revision ID: b7d42f0e9a61
Revises: c83917f0d52a
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7d42f0e9a61"
down_revision: str | Sequence[str] | None = "c83917f0d52a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("training_sessions") as batch:
        batch.add_column(sa.Column("purpose", sa.String(16), nullable=False, server_default="free"))
        batch.create_check_constraint(
            "training_session_purpose", "purpose IN ('scheduled', 'free')"
        )
    with op.batch_alter_table("training_items") as batch:
        batch.add_column(
            sa.Column("word_progress_version", sa.Integer(), nullable=False, server_default="1")
        )
    op.create_table(
        "word_progress",
        sa.Column("owner_id", sa.String(32), primary_key=True),
        sa.Column("word_id", sa.String(32), primary_key=True),
        sa.Column("stage", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("has_review", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("due_at", sa.DateTime(), nullable=True),
        sa.Column("last_review_at", sa.DateTime(), nullable=True),
        sa.Column("success_streak", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("review_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lapse_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("progress_version", sa.Integer(), nullable=False, server_default="1"),
        sa.ForeignKeyConstraint(
            ["owner_id", "word_id"], ["words.owner_id", "words.id"], ondelete="CASCADE"
        ),
        sa.CheckConstraint("stage BETWEEN 0 AND 6", name="word_progress_stage_range"),
        sa.CheckConstraint(
            "success_streak >= 0 AND review_count >= 0 AND lapse_count >= 0 "
            "AND progress_version >= 1",
            name="word_progress_counters",
        ),
        sa.Index("ix_word_progress_owner_due", "owner_id", "due_at"),
    )
    op.execute(
        """
        INSERT INTO word_progress (
            owner_id, word_id, stage, has_review, due_at, last_review_at,
            success_streak, review_count, lapse_count, progress_version
        )
        SELECT owner_id, id, 0, 0, NULL, NULL, 0, 0, 0, 1 FROM words
        """
    )


def downgrade() -> None:
    connection = op.get_bind()
    unsafe = connection.execute(
        sa.text(
            "SELECT EXISTS(SELECT 1 FROM training_sessions WHERE purpose != 'free') "
            "OR EXISTS(SELECT 1 FROM training_items WHERE word_progress_version != 1) "
            "OR EXISTS(SELECT 1 FROM word_progress WHERE stage != 0 OR has_review "
            "OR due_at IS NOT NULL OR last_review_at IS NOT NULL OR success_streak != 0 "
            "OR review_count != 0 OR lapse_count != 0 OR progress_version != 1)"
        )
    ).scalar_one()
    if unsafe:
        raise RuntimeError("Cannot downgrade while scheduled review state exists")
    op.drop_table("word_progress")
    with op.batch_alter_table("training_items") as batch:
        batch.drop_column("word_progress_version")
    with op.batch_alter_table("training_sessions") as batch:
        batch.drop_constraint("training_session_purpose", type_="check")
        batch.drop_column("purpose")

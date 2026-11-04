"""Preserve snapshots and record first objective attempts."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e65adf970121"
down_revision: str | Sequence[str] | None = "b7d42f0e9a61"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("statistics_started_at", sa.DateTime(), nullable=True))
    op.execute("UPDATE users SET statistics_started_at = CURRENT_TIMESTAMP")
    with op.batch_alter_table("users") as batch:
        batch.alter_column(
            "statistics_started_at",
            existing_type=sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        )
    with op.batch_alter_table("training_sessions") as batch:
        batch.add_column(
            sa.Column("status", sa.String(16), nullable=False, server_default="active")
        )
        batch.add_column(sa.Column("finished_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("requested_size", sa.String(32), nullable=True))
    with op.batch_alter_table(
        "training_items",
        naming_convention={"fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"},
    ) as batch:
        batch.drop_constraint("fk_training_items_word_id_words", type_="foreignkey")
        batch.alter_column("word_id", existing_type=sa.String(32), nullable=True)
        batch.create_foreign_key(
            "fk_training_items_word_id_words", "words", ["word_id"], ["id"], ondelete="SET NULL"
        )
    op.create_table(
        "answer_events",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column(
            "owner_id", sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("item_id", sa.String(32), nullable=False, unique=True),
        sa.Column("session_id", sa.String(32), nullable=False),
        sa.Column("word_id", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("direction", sa.String(8), nullable=False),
        sa.Column("purpose", sa.String(16), nullable=False),
        sa.Column("correct", sa.Boolean(), nullable=False),
        sa.Column("delta", sa.Integer(), nullable=False),
    )
    op.create_index("ix_answer_events_owner_id", "answer_events", ["owner_id"])


def downgrade() -> None:
    connection = op.get_bind()
    if (
        connection.execute(sa.text("SELECT count(*) FROM answer_events")).scalar_one()
        or connection.execute(
            sa.text("SELECT count(*) FROM training_items WHERE word_id IS NULL")
        ).scalar_one()
        or connection.execute(
            sa.text("SELECT count(*) FROM training_sessions WHERE status != 'active'")
        ).scalar_one()
    ):
        raise RuntimeError(
            "Cannot downgrade while answer history, deleted snapshots or finished sessions exist"
        )
    op.drop_index("ix_answer_events_owner_id", table_name="answer_events")
    op.drop_table("answer_events")
    with op.batch_alter_table(
        "training_items",
        naming_convention={"fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"},
    ) as batch:
        batch.drop_constraint("fk_training_items_word_id_words", type_="foreignkey")
        batch.alter_column("word_id", existing_type=sa.String(32), nullable=False)
        batch.create_foreign_key(
            "fk_training_items_word_id_words", "words", ["word_id"], ["id"], ondelete="CASCADE"
        )
    with op.batch_alter_table("training_sessions") as batch:
        batch.drop_column("requested_size")
        batch.drop_column("finished_at")
        batch.drop_column("status")
    with op.batch_alter_table("users") as batch:
        batch.drop_column("statistics_started_at")

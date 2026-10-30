"""Keep words after 100 percent and allow exclusion from training.

Revision ID: d90b58c2a113
Revises: 9c7e4261ab38
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d90b58c2a113"
down_revision: str | Sequence[str] | None = "9c7e4261ab38"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("words") as batch:
        batch.drop_constraint("progress_range", type_="check")
        batch.create_check_constraint("progress_range", "progress >= 0")
        batch.add_column(
            sa.Column("is_excluded", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch.add_column(
            sa.Column("training_version", sa.Integer(), nullable=False, server_default="1")
        )
    with op.batch_alter_table("training_items") as batch:
        batch.add_column(
            sa.Column("word_training_version", sa.Integer(), nullable=False, server_default="1")
        )
        batch.alter_column(
            "outcome", existing_type=sa.String(8), type_=sa.String(16), existing_nullable=True
        )


def downgrade() -> None:
    connection = op.get_bind()
    unsafe_words = connection.execute(
        sa.text(
            "SELECT count(*) FROM words WHERE progress > 100 OR is_excluded "
            "OR training_version != 1"
        )
    ).scalar_one()
    unsafe_items = connection.execute(
        sa.text(
            "SELECT count(*) FROM training_items WHERE outcome = 'unavailable' "
            "OR word_training_version != 1"
        )
    ).scalar_one()
    if unsafe_words or unsafe_items:
        raise RuntimeError("Cannot downgrade while training state or progress above 100 exists")
    with op.batch_alter_table("training_items") as batch:
        batch.alter_column(
            "outcome", existing_type=sa.String(16), type_=sa.String(8), existing_nullable=True
        )
        batch.drop_column("word_training_version")
    with op.batch_alter_table("words") as batch:
        batch.drop_column("training_version")
        batch.drop_column("is_excluded")
        batch.drop_constraint("progress_range", type_="check")
        batch.create_check_constraint("progress_range", "progress BETWEEN 0 AND 100")

"""Add private snapshots and responses for typed training.

Revision ID: 0d31c9a7e210
Revises: b24a4bb7ec9e
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0d31c9a7e210"
down_revision: str | Sequence[str] | None = "b24a4bb7ec9e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("training_items") as batch:
        batch.alter_column("correct_option", existing_type=sa.Integer(), nullable=True)
        batch.add_column(sa.Column("expected_answers", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("submitted_text", sa.String(200), nullable=True))


def downgrade() -> None:
    # Refuse data loss: the former schema cannot represent typed items.
    connection = op.get_bind()
    typed_count = connection.execute(
        sa.text("SELECT count(*) FROM training_items WHERE correct_option IS NULL")
    ).scalar_one()
    if typed_count:
        raise RuntimeError("Cannot downgrade while typed training items exist")
    with op.batch_alter_table("training_items") as batch:
        batch.drop_column("submitted_text")
        batch.drop_column("expected_answers")
        batch.alter_column("correct_option", existing_type=sa.Integer(), nullable=False)

"""Add reveal and self-assessment to card training.

Revision ID: e14c8f510e43
Revises: 0d31c9a7e210
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e14c8f510e43"
down_revision: str | Sequence[str] | None = "0d31c9a7e210"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("training_items") as batch:
        batch.add_column(sa.Column("revealed_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("grade", sa.String(8), nullable=True))


def downgrade() -> None:
    # The previous application cannot represent card sessions or ratings.
    card_count = (
        op.get_bind()
        .execute(sa.text("SELECT count(*) FROM training_sessions WHERE mode = 'cards'"))
        .scalar_one()
    )
    if card_count:
        raise RuntimeError("Cannot downgrade while card training sessions exist")
    with op.batch_alter_table("training_items") as batch:
        batch.drop_column("grade")
        batch.drop_column("revealed_at")

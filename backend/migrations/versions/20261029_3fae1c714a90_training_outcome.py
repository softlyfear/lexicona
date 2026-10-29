"""Record terminal assisted and skipped training outcomes.

Revision ID: 3fae1c714a90
Revises: e14c8f510e43
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3fae1c714a90"
down_revision: str | Sequence[str] | None = "e14c8f510e43"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("training_items") as batch:
        batch.add_column(sa.Column("outcome", sa.String(8), nullable=True))
    op.execute("UPDATE training_items SET outcome = 'answered' WHERE answered_at IS NOT NULL")


def downgrade() -> None:
    terminal_count = (
        op.get_bind()
        .execute(
            sa.text("SELECT count(*) FROM training_items WHERE outcome IN ('assisted', 'skipped')")
        )
        .scalar_one()
    )
    if terminal_count:
        raise RuntimeError("Cannot downgrade while assisted or skipped training items exist")
    with op.batch_alter_table("training_items") as batch:
        batch.drop_column("outcome")

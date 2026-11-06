"""Count letter hints used before the first typed answer.

Revision ID: a4c7e2b91d08
Revises: c1e8a4b07d52
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a4c7e2b91d08"
down_revision: str | Sequence[str] | None = "c1e8a4b07d52"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("training_items") as batch:
        batch.add_column(
            sa.Column("letter_hints", sa.Integer(), nullable=False, server_default="0")
        )


def downgrade() -> None:
    connection = op.get_bind()
    hinted = connection.execute(
        sa.text("SELECT count(*) FROM training_items WHERE letter_hints != 0")
    ).scalar_one()
    if hinted:
        raise RuntimeError("Cannot downgrade while letter hints exist")
    with op.batch_alter_table("training_items") as batch:
        batch.drop_column("letter_hints")

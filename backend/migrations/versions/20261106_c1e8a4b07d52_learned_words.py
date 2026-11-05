"""Mark a word learned without changing its progress.

Revision ID: c1e8a4b07d52
Revises: e65adf970121
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c1e8a4b07d52"
down_revision: str | Sequence[str] | None = "e65adf970121"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("words") as batch:
        batch.add_column(
            sa.Column("is_learned", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade() -> None:
    connection = op.get_bind()
    marked = connection.execute(sa.text("SELECT count(*) FROM words WHERE is_learned")).scalar_one()
    if marked:
        raise RuntimeError("Cannot downgrade while learned words exist")
    with op.batch_alter_table("words") as batch:
        batch.drop_column("is_learned")

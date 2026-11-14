"""Remember when a session opted into learned words.

Revision ID: c3a91e7b4d20
Revises: b7d4e1a83c90
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3a91e7b4d20"
down_revision: str | Sequence[str] | None = "b7d4e1a83c90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("training_sessions") as batch:
        batch.add_column(
            sa.Column("include_learned", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade() -> None:
    connection = op.get_bind()
    opted_in = connection.execute(
        sa.text("SELECT count(*) FROM training_sessions WHERE include_learned")
    ).scalar_one()
    if opted_in:
        raise RuntimeError("Cannot downgrade while a session includes learned words")
    with op.batch_alter_table("training_sessions") as batch:
        batch.drop_column("include_learned")

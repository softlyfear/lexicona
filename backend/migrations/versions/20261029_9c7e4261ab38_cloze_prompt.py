"""Support full personal examples as training prompts.

Revision ID: 9c7e4261ab38
Revises: 3fae1c714a90
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "9c7e4261ab38"
down_revision: str | Sequence[str] | None = "3fae1c714a90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("training_items") as batch:
        batch.alter_column(
            "prompt", existing_type=sa.String(200), type_=sa.Text(), existing_nullable=False
        )


def downgrade() -> None:
    connection = op.get_bind()
    cloze_count = connection.execute(
        sa.text("SELECT count(*) FROM training_sessions WHERE mode = 'cloze'")
    ).scalar_one()
    long_count = connection.execute(
        sa.text("SELECT count(*) FROM training_items WHERE length(prompt) > 200")
    ).scalar_one()
    if cloze_count or long_count:
        raise RuntimeError("Cannot downgrade while cloze sessions or long prompts exist")
    with op.batch_alter_table("training_items") as batch:
        batch.alter_column(
            "prompt", existing_type=sa.Text(), type_=sa.String(200), existing_nullable=False
        )

"""Mark offline training packages separately from resumable online sessions."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "965bd6296312"
down_revision: str | Sequence[str] | None = "eb7f79ed8af4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "training_sessions",
        sa.Column("is_offline", sa.Boolean(), server_default=sa.false(), nullable=False),
    )


def downgrade() -> None:
    marked = op.get_bind().scalar(
        sa.text("SELECT 1 FROM training_sessions WHERE is_offline LIMIT 1")
    )
    if marked:
        raise RuntimeError("Cannot downgrade while offline training packages exist")
    op.drop_column("training_sessions", "is_offline")

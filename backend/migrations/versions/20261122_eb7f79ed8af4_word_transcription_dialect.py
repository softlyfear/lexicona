"""Add an optional dialect to word transcriptions."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "eb7f79ed8af4"
down_revision: str | Sequence[str] | None = "7a6666654fbe"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("words", sa.Column("transcription_dialect", sa.String(2), nullable=True))


def downgrade() -> None:
    marked = op.get_bind().scalar(
        sa.text("SELECT 1 FROM words WHERE transcription_dialect IS NOT NULL LIMIT 1")
    )
    if marked:
        raise RuntimeError("Cannot downgrade while transcription dialects exist")
    op.drop_column("words", "transcription_dialect")

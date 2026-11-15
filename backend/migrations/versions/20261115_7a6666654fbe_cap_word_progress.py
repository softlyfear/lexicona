"""cap word progress

Revision ID: 7a6666654fbe
Revises: c3a91e7b4d20
Create Date: 2026-11-15 19:49:34.533267

"""

from collections.abc import Sequence

from alembic import op

revision: str = "7a6666654fbe"
down_revision: str | Sequence[str] | None = "c3a91e7b4d20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Progress is a percentage capped at 100. Clamp legacy values once.
    op.execute("UPDATE words SET progress = 100 WHERE progress > 100")


def downgrade() -> None:
    # The previous values are not recoverable; keep the capped data.
    pass

"""Add optional source provenance to words."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c83917f0d52a"
down_revision: str | Sequence[str] | None = "a71b3c9d8201"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("words", sa.Column("source_refs", sa.JSON(), nullable=True))


def downgrade() -> None:
    refs = (
        op.get_bind()
        .execute(sa.text("SELECT source_refs FROM words WHERE source_refs IS NOT NULL"))
        .scalars()
    )
    import json

    if any(json.loads(value) not in (None, []) for value in refs):
        raise RuntimeError("Cannot downgrade while source refs exist")
    op.drop_column("words", "source_refs")

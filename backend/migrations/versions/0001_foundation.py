"""Establish the explicit schema revision boundary, without dummy business tables.

Revision ID: 0001_foundation
Revises: None
"""

revision: str = "0001_foundation"
down_revision: str | None = None
branch_labels: tuple[str, ...] | None = None
depends_on: tuple[str, ...] | None = None


def upgrade() -> None:
    """Record the foundation baseline via Alembic's own version table."""


def downgrade() -> None:
    """Remove the revision marker; there are no business objects to remove."""

"""add reef_api_url to organizations

Revision ID: 233294252a25
Revises: 4d8e6a1f2b73
Create Date: 2026-06-09 12:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "233294252a25"
down_revision: str | Sequence[str] | None = "4d8e6a1f2b73"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("organizations") as batch:
        batch.add_column(sa.Column("reef_api_url", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("organizations") as batch:
        batch.drop_column("reef_api_url")

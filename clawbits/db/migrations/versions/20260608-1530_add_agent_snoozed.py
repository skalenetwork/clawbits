"""add agent snooze flag

Revision ID: 3f4b0c8e9a12
Revises: 8b62d4f9012a
Create Date: 2026-06-08 15:30:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3f4b0c8e9a12"
down_revision: str | Sequence[str] | None = "8b62d4f9012a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.add_column(
            sa.Column(
                "snoozed",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.drop_column("snoozed")

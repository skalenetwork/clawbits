"""add inter-agent mode flag to agents

Revision ID: 8b62d4f9012a
Revises: d4f9a1c3e207
Create Date: 2026-06-05 09:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8b62d4f9012a"
down_revision: str | Sequence[str] | None = "d4f9a1c3e207"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.add_column(
            sa.Column(
                "inter_agent_mode_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.drop_column("inter_agent_mode_enabled")

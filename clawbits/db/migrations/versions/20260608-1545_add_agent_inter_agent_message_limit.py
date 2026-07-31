"""add agent inter-agent message limit

Revision ID: 4d8e6a1f2b73
Revises: 3f4b0c8e9a12
Create Date: 2026-06-08 15:45:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4d8e6a1f2b73"
down_revision: str | Sequence[str] | None = "3f4b0c8e9a12"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.add_column(
            sa.Column(
                "inter_agent_message_limit",
                sa.Integer(),
                nullable=False,
                server_default="10",
            )
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.drop_column("inter_agent_message_limit")

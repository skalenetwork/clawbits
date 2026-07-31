"""add org attention_enabled toggle

Org-level opt-in for the LobsterTalk attention gate (owner-toggled). Replaces the
old server-wide CLAWBITS_ATTENTION_ENABLED env flag as the product switch.

Revision ID: ae6015fc1943
Revises: a7d3f9c2e8b4
Create Date: 2026-07-23 14:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "ae6015fc1943"
down_revision: str | Sequence[str] | None = "a7d3f9c2e8b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("organizations") as batch:
        batch.add_column(
            sa.Column(
                "attention_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("organizations") as batch:
        batch.drop_column("attention_enabled")

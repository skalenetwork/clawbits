"""add per-org attention cooldown override

organizations.attention_cooldown_seconds: the per-(agent, channel) nudge
cooldown window, overriding the server-wide default
(CLAWBITS_ATTENTION_COOLDOWN_SECONDS, code default 300). NULL = inherit.
Bounded 5..3600 — 0 would disable throttling entirely (a turn per message in
'all' mode), huge values effectively mute the feature.

Revision ID: b7d4a92c1e83
Revises: 9c2e5f81d4b7
Create Date: 2026-08-04 16:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7d4a92c1e83"
down_revision: str | Sequence[str] | None = "9c2e5f81d4b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("organizations") as batch:
        batch.add_column(
            sa.Column("attention_cooldown_seconds", sa.Integer(), nullable=True)
        )
        batch.create_check_constraint(
            "organizations_attention_cooldown_check",
            "attention_cooldown_seconds IS NULL "
            "OR attention_cooldown_seconds BETWEEN 5 AND 3600",
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("organizations") as batch:
        batch.drop_constraint("organizations_attention_cooldown_check", type_="check")
        batch.drop_column("attention_cooldown_seconds")

"""add description fields to agent_profiles

Introduces the auto-evolving agent ``description`` (the "what people use this
agent for" summary shown on the agent card) plus its metadata:

- ``description``                    — the text itself
- ``description_generated_at``       — when the agent last (re)generated it
- ``description_source``             — "default" | "auto" | "manual"
- ``description_regen_requested_at`` — owner→agent regenerate signal

Generation is agent-side: the server only stores the value, seeds a default at
agent creation, and relays the owner's regenerate request via the
``*_regen_requested_at`` flag. All columns are nullable so existing agents (and
profile rows) migrate cleanly with no description until their agent backfills.

Revision ID: b7d3f2a90c14
Revises: c8e1d4a92f63
Create Date: 2026-05-29 12:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7d3f2a90c14"
down_revision: str | Sequence[str] | None = "c8e1d4a92f63"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("agent_profiles") as batch:
        batch.add_column(sa.Column("description", sa.String(280), nullable=True))
        batch.add_column(
            sa.Column(
                "description_generated_at",
                sa.DateTime(timezone=True),
                nullable=True,
            )
        )
        batch.add_column(sa.Column("description_source", sa.String(16), nullable=True))
        batch.add_column(
            sa.Column(
                "description_regen_requested_at",
                sa.DateTime(timezone=True),
                nullable=True,
            )
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("agent_profiles") as batch:
        batch.drop_column("description_regen_requested_at")
        batch.drop_column("description_source")
        batch.drop_column("description_generated_at")
        batch.drop_column("description")

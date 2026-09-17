"""add model selection

The operator's model and thinking choice: the agent default on ``agents``, a conversation's
own on ``agent_channel_state``, NULL inheriting per field. ``agent_model_catalog`` holds the
models the agent's engine reported it can call, one row per agent.

Revision ID: 5c9e2a7d4b13
Revises: a4d2c8e61f37
Create Date: 2026-09-17 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "5c9e2a7d4b13"
down_revision: str | Sequence[str] | None = "a4d2c8e61f37"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for table in ("agents", "agent_channel_state"):
        op.add_column(table, sa.Column("model", sa.Text(), nullable=True))
        op.add_column(table, sa.Column("thinking", sa.Text(), nullable=True))
    op.create_table(
        "agent_model_catalog",
        sa.Column("agent_id", sa.String(), sa.ForeignKey("agents.agent_id"), primary_key=True),
        sa.Column("catalog_hash", sa.Text(), nullable=False),
        sa.Column("models", postgresql.JSONB(), nullable=False),
        sa.Column("default_model", sa.Text(), nullable=True),
        sa.Column("default_thinking", sa.Text(), nullable=True),
        sa.Column("reported_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("agent_model_catalog")
    for table in ("agents", "agent_channel_state"):
        op.drop_column(table, "thinking")
        op.drop_column(table, "model")

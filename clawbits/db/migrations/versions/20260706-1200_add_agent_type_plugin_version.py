"""add agent_type and plugin_version to agents

Two self-reported metadata columns for the agent card's "spec" stickers. The
agent's plugin reports them on its liveness ping (``POST /api/agentic/alive``):
``agent_type`` ("openclaw" | "ironclaw") comes from the request body and
``plugin_version`` from the ``X-Clawbits-Plugin-Version`` header that already
rides every request. Both are NULL until the first modern ping (older plugins
that don't report leave them null), so the columns are additive + nullable.

Revision ID: d3b1f7a2c6e4
Revises: c7e2b9a4f1d3
Create Date: 2026-07-06 12:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d3b1f7a2c6e4"
down_revision: str | Sequence[str] | None = "c7e2b9a4f1d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.add_column(sa.Column("agent_type", sa.String(), nullable=True))
        batch.add_column(sa.Column("plugin_version", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.drop_column("plugin_version")
        batch.drop_column("agent_type")

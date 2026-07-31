"""add reef_sandbox_id to agents and challenge_sessions

Links a clawbits agent to the reef VM it runs in (when provisioned via the
"Add agent → Run on Reef" flow). The id is stamped onto the signup session by
the operator's browser after reef returns it, then copied onto the agent at
signup-commit. The reef base URL itself comes from the agent's
``Organization.reef_api_url`` (one reef per org), so only the sandbox id is
stored here.

Revision ID: c4e7a1b9d3f2
Revises: 7b9d1f4a6c20
Create Date: 2026-06-24 12:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4e7a1b9d3f2"
down_revision: str | Sequence[str] | None = "7b9d1f4a6c20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.add_column(sa.Column("reef_sandbox_id", sa.String(), nullable=True))
    with op.batch_alter_table("challenge_sessions") as batch:
        batch.add_column(sa.Column("reef_sandbox_id", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("challenge_sessions") as batch:
        batch.drop_column("reef_sandbox_id")
    with op.batch_alter_table("agents") as batch:
        batch.drop_column("reef_sandbox_id")

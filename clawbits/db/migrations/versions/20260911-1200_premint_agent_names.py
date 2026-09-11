"""pick a human-minted agent's id and nickname when its session is minted

A human signup session now carries the agent id and nickname it will commit
under, so a reef fleet file can be named after the agent before it boots. The id is
unique across sessions, so two concurrent mints never hold the same one.

Revision ID: 0006d9316d3e
Revises: f2b7c40d9e18
Create Date: 2026-09-11 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006d9316d3e"
down_revision: str | Sequence[str] | None = "f2b7c40d9e18"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("challenge_sessions") as batch:
        batch.add_column(sa.Column("agent_id", sa.String(), nullable=True))
        batch.add_column(sa.Column("nickname", sa.String(), nullable=True))
    op.create_index(
        op.f("ix_challenge_sessions_agent_id"), "challenge_sessions", ["agent_id"], unique=True
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_challenge_sessions_agent_id"), table_name="challenge_sessions")
    with op.batch_alter_table("challenge_sessions") as batch:
        batch.drop_column("nickname")
        batch.drop_column("agent_id")

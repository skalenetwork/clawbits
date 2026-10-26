"""reef: each org's own GitHub App replaces the stored token; moved agents re-enrol as themselves

The org no longer stores a sealed fine-grained token. Connecting creates a
GitHub App owned by the org, from a manifest, and installs it on the one
repository: the org keeps that App's id, slug and sealed private key, and its
installation id, and every call mints its own short-lived token. Stored tokens
are dropped, not migrated: an org reconnects through the new flow.

A signup session can now name an existing agent to rebind: moving a reef agent
writes a fleet file whose token, at commit, hands that agent a new key instead
of creating a new agent. The session goes with the agent.

Revision ID: 7c3e9a1b5d20
Revises: 59a1f4320c15
Create Date: 2026-10-21 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "7c3e9a1b5d20"
down_revision: str | Sequence[str] | None = "59a1f4320c15"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("organizations") as batch:
        batch.drop_column("reef_repo_token")
        batch.add_column(sa.Column("reef_app_id", sa.BigInteger(), nullable=True))
        batch.add_column(sa.Column("reef_app_slug", sa.String(), nullable=True))
        batch.add_column(sa.Column("reef_app_key", sa.Text(), nullable=True))
        batch.add_column(sa.Column("reef_installation_id", sa.BigInteger(), nullable=True))
    with op.batch_alter_table("challenge_sessions") as batch:
        batch.add_column(sa.Column("rebind_agent_id", sa.String(), nullable=True))
        batch.create_foreign_key(
            "challenge_sessions_rebind_agent_id_fkey",
            "agents",
            ["rebind_agent_id"],
            ["agent_id"],
            ondelete="CASCADE",
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("challenge_sessions") as batch:
        batch.drop_constraint("challenge_sessions_rebind_agent_id_fkey", type_="foreignkey")
        batch.drop_column("rebind_agent_id")
    with op.batch_alter_table("organizations") as batch:
        batch.drop_column("reef_installation_id")
        batch.drop_column("reef_app_key")
        batch.drop_column("reef_app_slug")
        batch.drop_column("reef_app_id")
        batch.add_column(sa.Column("reef_repo_token", sa.Text(), nullable=True))

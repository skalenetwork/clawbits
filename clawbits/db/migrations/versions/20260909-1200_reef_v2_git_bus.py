"""replace the reef v1 columns with the git-bus ones

Reef v1 had clawbits call a self-hosted reef API over the owner's tunnel, so
the org stored that base URL and each agent stored the VM id reef handed back.
Reef v2 inverts the direction: git is the bus. The org stores its private
repository (``owner/name``) and a Fernet-sealed fine-grained token scoped to
it; clawbits writes ``fleet/<host>/<name>.toml`` and reads ``status/<host>.json``,
and a timer on the reef host pulls. Nothing on the network reaches the host, so
there is no URL to store and no sandbox id to receive.

An agent is therefore addressed by the pair it was declared under — host and
name — which the signup session carries from Create through to commit. Both
sides of that pair replace the single sandbox id.

The v1 values are dropped, not migrated: v1 agents are recreated through the
new flow, and a reef API URL has no meaning under the git bus.

Revision ID: f2b7c40d9e18
Revises: e7b3c1d95a48
Create Date: 2026-09-09 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f2b7c40d9e18"
down_revision: str | Sequence[str] | None = "e7b3c1d95a48"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("organizations") as batch:
        batch.drop_column("reef_api_url")
        batch.add_column(sa.Column("reef_repo", sa.String(), nullable=True))
        batch.add_column(sa.Column("reef_repo_token", sa.Text(), nullable=True))
    for table in ("agents", "challenge_sessions"):
        with op.batch_alter_table(table) as batch:
            batch.drop_column("reef_sandbox_id")
            batch.add_column(sa.Column("reef_host", sa.String(), nullable=True))
            batch.add_column(sa.Column("reef_name", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    for table in ("challenge_sessions", "agents"):
        with op.batch_alter_table(table) as batch:
            batch.drop_column("reef_name")
            batch.drop_column("reef_host")
            batch.add_column(sa.Column("reef_sandbox_id", sa.String(), nullable=True))
    with op.batch_alter_table("organizations") as batch:
        batch.drop_column("reef_repo_token")
        batch.drop_column("reef_repo")
        batch.add_column(sa.Column("reef_api_url", sa.String(), nullable=True))

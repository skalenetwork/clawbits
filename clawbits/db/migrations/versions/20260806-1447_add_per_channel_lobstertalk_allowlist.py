"""add per-channel lobstertalk allowlist

Strictly closed by default: the attention pass now runs only in public
channels the org owner has explicitly approved (Settings → LobsterTalk),
on top of the existing org and per-agent toggles. Deliberately NO
backfill — every existing channel comes up unapproved, so LobsterTalk
pauses org-wide on deploy until owners approve channels. That is the
intended rollout, not an oversight; don't "fix" it with a data migration.

Revision ID: 43932ee1b7e1
Revises: c3f8b17d29a4
Create Date: 2026-08-06 14:47:41.216128
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "43932ee1b7e1"
down_revision: str | Sequence[str] | None = "c3f8b17d29a4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("mm_channels") as batch:
        batch.add_column(
            sa.Column(
                "lobstertalk_approved",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("mm_channels") as batch:
        batch.drop_column("lobstertalk_approved")

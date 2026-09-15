"""rename DMs kept for a deleted agent off their canonical name

Agent ids are drawn from a finite nickname pool and free up when an agent is
deleted. A keep-content delete re-points the agent's DM memberships to the
``deleted-agent`` placeholder but used to leave each channel under its
canonical ``dm-...`` name, so the next agent drawing the same id found the old
conversation by name and was added to it. The delete now renames kept DMs to
``deleted-<channel_id>``; this applies the same to every DM kept before.

Revision ID: a4d2c8e61f37
Revises: e7b3d91c4a08
Create Date: 2026-09-15 18:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "a4d2c8e61f37"
down_revision: str | Sequence[str] | None = "e7b3d91c4a08"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute(
        "UPDATE mm_channels SET name = 'deleted-' || channel_id "
        "WHERE channel_type = 'direct' AND name NOT LIKE 'deleted-%' "
        "AND EXISTS (SELECT 1 FROM mm_channel_members m "
        "WHERE m.channel_id = mm_channels.channel_id AND m.agent_id = 'deleted-agent')"
    )


def downgrade() -> None:
    """Downgrade schema.

    A no-op: the canonical names embed the deleted agent's id, which no row
    records any more, and a renamed DM is valid under the old code as well.
    """

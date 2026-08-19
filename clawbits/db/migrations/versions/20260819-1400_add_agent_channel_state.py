"""add agent_channel_state — durable per-agent read pointers

The agent twin of ``human_channel_state``, minus the human-only UI flags
(mute/pin). ``last_read_post_id`` is the agent's restart resume point: the
plugin acks it when a turn settles and, after a restart, drains
``GET /posts?after_post_id=<pointer>`` to process exactly the messages that
arrived while the process was down. Server-side because every client-side
home for this cursor has proven lossy — OpenClaw's state file lives on the
guest rootfs (wiped by recreate/upgrade) and Hermes kept cursors in memory
only (see restart-unread-catchup.md).

No backfill: a missing row means "no pointer yet", which plugins treat as
first boot (seed to newest, then ack) — so rollout does not replay history.

Revision ID: b3a7e29c8d41
Revises: 0dbdebfbae3a
Create Date: 2026-08-19 14:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3a7e29c8d41"
down_revision: str | Sequence[str] | None = "0dbdebfbae3a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "agent_channel_state",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "agent_id",
            sa.String(),
            sa.ForeignKey("agents.agent_id"),
            nullable=False,
        ),
        sa.Column(
            "channel_id",
            sa.String(),
            sa.ForeignKey("mm_channels.channel_id"),
            nullable=False,
        ),
        sa.Column(
            "last_read_post_id",
            sa.Integer(),
            sa.ForeignKey("mm_posts.post_id"),
            nullable=True,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.UniqueConstraint(
            "agent_id", "channel_id", name="uq_agent_channel_state_agent_channel"
        ),
    )
    op.create_index(
        op.f("ix_agent_channel_state_agent_id"),
        "agent_channel_state",
        ["agent_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_agent_channel_state_channel_id"),
        "agent_channel_state",
        ["channel_id"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        op.f("ix_agent_channel_state_channel_id"), table_name="agent_channel_state"
    )
    op.drop_index(
        op.f("ix_agent_channel_state_agent_id"), table_name="agent_channel_state"
    )
    op.drop_table("agent_channel_state")

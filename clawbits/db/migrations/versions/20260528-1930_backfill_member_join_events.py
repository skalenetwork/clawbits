"""backfill member-level join events for existing channel members

The earlier creator-join backfill (``a4f7c2e9b531``) only surfaced rows
for the human who *created* each channel. Users who joined later via
``join_channel`` (public-channel self-join) or ``add_member`` before the
events table existed have no row to render either, so their timeline
still opens without a "joined" anchor at the top.

This migration extends the backfill: one ``member.added`` row per
existing ``mm_channel_members`` entry with a non-NULL ``human_id``,
authored as a self-join (actor == subject so the renderer picks
"joined the channel"). We can't recover *who added them* from the
membership row alone — older history doesn't store that — so even
users who were added by someone else show as a self-join. That's a
lossy but defensible approximation, and any later real
``member.added`` / ``member.removed`` event for the same person
sits below the backfilled row in chronological order.

DMs are skipped (they never accumulate events). Agents are skipped
(``actor_*`` requires exactly one identity kind; agent-joined rows are
out of scope for now). The NOT EXISTS guard makes the migration
idempotent and also avoids clobbering the creator backfill —
``a4f7c2e9b531`` already inserted a row at the channel's ``created_at``
for the creator, so when we re-process the same human here we skip them.

Revision ID: c8e1d4a92f63
Revises: a4f7c2e9b531
Create Date: 2026-05-28 19:30:00.000000

"""
from collections.abc import Sequence

from alembic import op

revision: str = "c8e1d4a92f63"
down_revision: str | Sequence[str] | None = "a4f7c2e9b531"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO mm_channel_events
            (channel_id, event_type, actor_human_id, created_at)
        SELECT
            m.channel_id,
            'member.added',
            m.human_id,
            COALESCE(m.joined_at, c.created_at)
        FROM mm_channel_members AS m
        JOIN mm_channels AS c ON c.channel_id = m.channel_id
        WHERE c.channel_type != 'direct'
          AND m.human_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM mm_channel_events AS e
              WHERE e.channel_id = m.channel_id
                AND e.event_type = 'member.added'
                AND e.actor_human_id = m.human_id
                AND e.subject_human_id IS NULL
                AND e.subject_agent_id IS NULL
          )
        """
    )


def downgrade() -> None:
    # Reverse: drop rows whose shape matches the backfill — self-action
    # (subject NULL on both axes), actor is a current member, and the
    # event's ``created_at`` matches the member's ``joined_at``. A real
    # subsequent self-join would have a different timestamp and is
    # preserved.
    op.execute(
        """
        DELETE FROM mm_channel_events AS e
        USING mm_channel_members AS m
        WHERE e.channel_id = m.channel_id
          AND e.event_type = 'member.added'
          AND e.actor_human_id = m.human_id
          AND e.subject_human_id IS NULL
          AND e.subject_agent_id IS NULL
          AND e.created_at = m.joined_at
        """
    )

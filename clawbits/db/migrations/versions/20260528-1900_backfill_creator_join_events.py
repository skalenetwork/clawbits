"""backfill creator-join events for existing channels

When a channel is created the API now emits a ``member.added`` row with
``actor_human_id = subject_human_id = created_by_human`` so the timeline
shows the creator a "You joined the channel" system message. Existing
channels missed that emit (the table didn't exist, or the endpoint
didn't push one) — backfill one row per channel where:

  - ``channel_type != 'direct'``  (DMs never accumulate events)
  - ``created_by_human IS NOT NULL`` (skip agent-only / system channels)
  - no existing ``member.added`` row already names this human as actor
    (idempotent re-run; protects against partial earlier backfills)

``created_at`` is set to the channel's own ``created_at`` so the row
sorts at the top of the timeline — the same place a real creator emit
would have landed.

Revision ID: a4f7c2e9b531
Revises: a92c81f6d340
Create Date: 2026-05-28 19:00:00.000000

"""
from collections.abc import Sequence

from alembic import op

revision: str = "a4f7c2e9b531"
down_revision: str | Sequence[str] | None = "a92c81f6d340"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO mm_channel_events
            (channel_id, event_type, actor_human_id, created_at)
        SELECT
            c.channel_id,
            'member.added',
            c.created_by_human,
            c.created_at
        FROM mm_channels AS c
        WHERE c.channel_type != 'direct'
          AND c.created_by_human IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM mm_channel_events AS e
              WHERE e.channel_id = c.channel_id
                AND e.event_type = 'member.added'
                AND e.actor_human_id = c.created_by_human
                AND e.subject_human_id IS NULL
                AND e.subject_agent_id IS NULL
          )
        """
    )


def downgrade() -> None:
    # Reverse: drop only rows whose shape matches what we inserted —
    # actor matches the channel's creator, subject is NULL on both axes,
    # and ``created_at`` equals the channel's own creation timestamp. A
    # real subsequent self-join (a user who left and re-joined a public
    # channel they created) would have a later ``created_at`` and is
    # preserved.
    op.execute(
        """
        DELETE FROM mm_channel_events AS e
        USING mm_channels AS c
        WHERE e.channel_id = c.channel_id
          AND e.event_type = 'member.added'
          AND e.actor_human_id = c.created_by_human
          AND e.subject_human_id IS NULL
          AND e.subject_agent_id IS NULL
          AND e.created_at = c.created_at
        """
    )

"""expand Tidemarks: the agent_days tally and the open- and deep-water marks

``agent_days`` is the insert-only day tally the streak marks read; everything else is backfill,
dating each new mark from surviving history.

Two things here are not mechanical. The conversation and teamwork statements re-run WITHOUT the
``channel_type = 'direct'`` filter the original backfill carried: both marks now fire in any
channel, and agents that only ever talked in a team room were owed them all along. And the talking
days are a reconstruction, not a replay — a day an agent published in a channel a person belongs
to, which is looser than the runtime rule (an agent post that answers a person's). Night needs a
presence reading nobody kept, so it lands on the next post; weathered and year are pure age and are
read off the clock, never stored.

Revision ID: 3f7b0c92ad41
Revises: 5c9e2a7d4b13
Create Date: 2026-09-18 11:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3f7b0c92ad41"
down_revision: str | Sequence[str] | None = "5c9e2a7d4b13"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_BACKFILL = (
    """
    WITH first_human AS (
        SELECT DISTINCT ON (channel_id) channel_id, human_id, post_id
        FROM mm_posts
        WHERE status = 'published' AND human_id IS NOT NULL
        ORDER BY channel_id, post_id
    )
    INSERT INTO agent_marks (agent_id, kind, earned_at, detail)
    SELECT DISTINCT ON (p.agent_id)
        p.agent_id, 'conversation', coalesce(p.created_at, now()),
        jsonb_build_object('human_id', h.human_id)
    FROM first_human h
    JOIN mm_posts p ON p.channel_id = h.channel_id AND p.post_id > h.post_id
    LEFT JOIN mm_posts parent ON parent.post_id = p.parent_post_id
    WHERE p.status = 'published'
        AND p.agent_id IS NOT NULL
        AND p.agent_id <> 'deleted-agent'
        AND lower(regexp_replace(parent.message, '^\\s+|\\s+$', '', 'g'))
            IS DISTINCT FROM '/cb-usage'
    ORDER BY p.agent_id, p.post_id
    ON CONFLICT DO NOTHING
    """,
    """
    WITH firsts AS (
        SELECT channel_id, agent_id, min(coalesce(created_at, now())) AS first_at
        FROM mm_posts
        WHERE status = 'published' AND agent_id IS NOT NULL AND agent_id <> 'deleted-agent'
        GROUP BY channel_id, agent_id
    ), ranked AS (
        SELECT a.agent_id, b.agent_id AS peer_agent_id,
               greatest(a.first_at, b.first_at) AS met_at,
               dense_rank() OVER (
                   PARTITION BY a.agent_id
                   ORDER BY greatest(a.first_at, b.first_at), b.agent_id
               ) AS peer_rank
        FROM firsts a
        JOIN firsts b ON b.channel_id = a.channel_id AND b.agent_id <> a.agent_id
    )
    INSERT INTO agent_marks (agent_id, kind, earned_at, detail)
    SELECT DISTINCT ON (agent_id, peer_rank > 1)
        agent_id,
        CASE WHEN peer_rank > 1 THEN 'handoff' ELSE 'teamwork' END,
        met_at,
        jsonb_build_object('peer_agent_id', peer_agent_id)
    FROM ranked
    ORDER BY agent_id, peer_rank > 1, met_at
    ON CONFLICT DO NOTHING
    """,
    """
    INSERT INTO agent_marks (agent_id, kind, earned_at)
    SELECT m.agent_id, 'file', coalesce(min(f.created_at), now())
    FROM mm_files f
    JOIN mm_channel_members m ON m.channel_id = f.channel_id
    WHERE f.post_id IS NOT NULL
        AND f.deleted_at IS NULL
        AND m.agent_id IS NOT NULL
        AND m.agent_id <> 'deleted-agent'
    GROUP BY m.agent_id
    ON CONFLICT DO NOTHING
    """,
    """
    INSERT INTO agent_marks (agent_id, kind, earned_at, detail)
    SELECT DISTINCT ON (agent_id)
        agent_id, 'skill', coalesce(updated_at, now()), jsonb_build_object('skill_id', skill_id)
    FROM agent_skill_installs
    WHERE deleted_at IS NULL AND managed_by = 'clawbits' AND agent_id <> 'deleted-agent'
    ORDER BY agent_id, updated_at NULLS LAST
    ON CONFLICT DO NOTHING
    """,
    """
    INSERT INTO agent_marks (agent_id, kind, earned_at)
    SELECT agent_id, 'run', min(coalesce(finished_at, started_at, now()))
    FROM automation_runs
    WHERE agent_id <> 'deleted-agent'
        AND lower(coalesce(status, '')) NOT IN ('error', 'failed', 'failure')
    GROUP BY agent_id
    ON CONFLICT DO NOTHING
    """,
    """
    INSERT INTO agent_marks (agent_id, kind, earned_at)
    SELECT agent_id, 'thread', min(coalesce(created_at, now()))
    FROM mm_posts
    WHERE status = 'published'
        AND agent_id IS NOT NULL
        AND agent_id <> 'deleted-agent'
        AND parent_post_id IS NOT NULL
    GROUP BY agent_id
    ON CONFLICT DO NOTHING
    """,
    """
    INSERT INTO agent_marks (agent_id, kind, earned_at)
    SELECT agent_id, 'pinned', min(pinned_at)
    FROM mm_posts
    WHERE pinned_at IS NOT NULL AND agent_id IS NOT NULL AND agent_id <> 'deleted-agent'
    GROUP BY agent_id
    ON CONFLICT DO NOTHING
    """,
    """
    WITH crews AS (
        SELECT channel_id FROM mm_channel_members
        WHERE agent_id IS NOT NULL AND agent_id <> 'deleted-agent'
        GROUP BY channel_id HAVING count(*) >= 3
    )
    INSERT INTO agent_marks (agent_id, kind, earned_at, detail)
    SELECT DISTINCT ON (p.agent_id)
        p.agent_id, 'crew', coalesce(p.created_at, now()),
        jsonb_build_object('channel_id', p.channel_id)
    FROM mm_posts p
    JOIN crews ON crews.channel_id = p.channel_id
    WHERE p.status = 'published' AND p.agent_id IS NOT NULL AND p.agent_id <> 'deleted-agent'
    ORDER BY p.agent_id, p.post_id
    ON CONFLICT DO NOTHING
    """,
    """
    INSERT INTO agent_days (agent_id, track, day)
    SELECT DISTINCT p.agent_id, 'talk', (coalesce(p.created_at, now()) AT TIME ZONE 'UTC')::date
    FROM mm_posts p
    WHERE p.status = 'published'
        AND p.agent_id IS NOT NULL
        AND p.agent_id <> 'deleted-agent'
        AND EXISTS (
            SELECT 1 FROM mm_channel_members m
            WHERE m.channel_id = p.channel_id AND m.human_id IS NOT NULL
        )
    ON CONFLICT DO NOTHING
    """,
    """
    INSERT INTO agent_days (agent_id, track, day)
    SELECT DISTINCT agent_id, 'run',
        (coalesce(finished_at, started_at, now()) AT TIME ZONE 'UTC')::date
    FROM automation_runs
    WHERE agent_id <> 'deleted-agent'
        AND lower(coalesce(status, '')) NOT IN ('error', 'failed', 'failure')
    ON CONFLICT DO NOTHING
    """,
    """
    WITH islands AS (
        SELECT agent_id, track, day,
               day - (row_number() OVER w) * INTERVAL '1 day' AS island,
               row_number() OVER w AS total
        FROM agent_days
        WINDOW w AS (PARTITION BY agent_id, track ORDER BY day)
    ), counted AS (
        SELECT agent_id, track, day, total,
               row_number() OVER (PARTITION BY agent_id, track, island ORDER BY day) AS streak
        FROM islands
    )
    INSERT INTO agent_marks (agent_id, kind, earned_at)
    SELECT DISTINCT ON (agent_id, m.kind) agent_id, m.kind, day + TIME '12:00'
    FROM counted
    JOIN (VALUES ('streak3', 'talk', 3, true), ('streak7', 'talk', 7, true),
                 ('streak30', 'talk', 30, true), ('clockwork', 'run', 7, true),
                 ('tides', 'talk', 100, false)) AS m(kind, track, needed, consecutive)
      ON m.track = counted.track
    WHERE (CASE WHEN m.consecutive THEN streak ELSE total END) >= m.needed
    ORDER BY agent_id, m.kind, day
    ON CONFLICT DO NOTHING
    """,
)


def upgrade() -> None:
    op.create_table(
        "agent_days",
        sa.Column("agent_id", sa.String(), sa.ForeignKey("agents.agent_id"), primary_key=True),
        sa.Column("track", sa.Text(), primary_key=True),
        sa.Column("day", sa.Date(), primary_key=True),
    )
    for statement in _BACKFILL:
        op.execute(statement)


def downgrade() -> None:
    op.execute(
        "DELETE FROM agent_marks WHERE kind IN ("
        "'file', 'skill', 'run', 'thread', 'pinned', 'crew', 'night', 'handoff',"
        " 'streak3', 'streak7', 'streak30', 'clockwork', 'tides', 'weathered', 'year')"
    )
    op.drop_table("agent_days")

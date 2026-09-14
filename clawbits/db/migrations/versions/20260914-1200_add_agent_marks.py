"""add agent_marks, the Tidemarks ledger

One row per first-time agent achievement, keyed (agent_id, kind). Insert-only: a mark never
drops, even when the thing behind it is undone. ``kind`` is plain text with no check constraint,
validated in code, so a new kind needs no migration.

The backfill dates each mark from surviving history: conversation from the first published agent
post after a human's in a direct channel (the server's /cb-usage reply excluded), teamwork from
the moment both agents of a direct channel have published, channel from the earliest non-direct,
non-default membership or member.added event, automation from the earliest operator-created
(managed_by clawbits) automations row including tombstones, never the agent's own mirrored jobs,
and lobstertalk from now for agents that have it on. Mail has no history in Postgres and lands on
the next inbox count read.

Revision ID: c4e1a9b27d53
Revises: 700d156ea6db
Create Date: 2026-09-14 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c4e1a9b27d53"
down_revision: str | Sequence[str] | None = "700d156ea6db"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_marks",
        sa.Column("agent_id", sa.String(), sa.ForeignKey("agents.agent_id"), primary_key=True),
        sa.Column("kind", sa.Text(), primary_key=True),
        sa.Column(
            "earned_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("detail", postgresql.JSONB()),
    )
    for statement in (
        """
        WITH first_human AS (
            SELECT DISTINCT ON (p.channel_id) p.channel_id, p.human_id, p.post_id
            FROM mm_posts p
            JOIN mm_channels c ON c.channel_id = p.channel_id AND c.channel_type = 'direct'
            WHERE p.status = 'published' AND p.human_id IS NOT NULL
            ORDER BY p.channel_id, p.post_id
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
            SELECT p.channel_id, p.agent_id, min(coalesce(p.created_at, now())) AS first_at
            FROM mm_posts p
            JOIN mm_channels c ON c.channel_id = p.channel_id AND c.channel_type = 'direct'
            WHERE p.status = 'published'
                AND p.agent_id IS NOT NULL
                AND p.agent_id <> 'deleted-agent'
            GROUP BY p.channel_id, p.agent_id
        )
        INSERT INTO agent_marks (agent_id, kind, earned_at, detail)
        SELECT DISTINCT ON (a.agent_id)
            a.agent_id, 'teamwork', greatest(a.first_at, b.first_at),
            jsonb_build_object('peer_agent_id', b.agent_id)
        FROM firsts a
        JOIN firsts b ON b.channel_id = a.channel_id AND b.agent_id <> a.agent_id
        ORDER BY a.agent_id, greatest(a.first_at, b.first_at)
        ON CONFLICT DO NOTHING
        """,
        """
        INSERT INTO agent_marks (agent_id, kind, earned_at, detail)
        SELECT DISTINCT ON (j.agent_id)
            j.agent_id, 'channel', coalesce(j.at, c.created_at, now()),
            jsonb_build_object('channel_id', j.channel_id)
        FROM (
            SELECT agent_id, channel_id, joined_at AS at
            FROM mm_channel_members
            WHERE agent_id IS NOT NULL
            UNION ALL
            SELECT subject_agent_id, channel_id, created_at
            FROM mm_channel_events
            WHERE event_type = 'member.added' AND subject_agent_id IS NOT NULL
        ) j
        JOIN mm_channels c ON c.channel_id = j.channel_id
        WHERE c.channel_type <> 'direct'
            AND c.name <> 'agent-' || j.agent_id
            AND j.agent_id <> 'deleted-agent'
        ORDER BY j.agent_id, coalesce(j.at, c.created_at, now())
        ON CONFLICT DO NOTHING
        """,
        """
        INSERT INTO agent_marks (agent_id, kind, earned_at, detail)
        SELECT DISTINCT ON (agent_id)
            agent_id, 'automation', coalesce(created_at, now()),
            jsonb_build_object('automation_id', automation_id)
        FROM automations
        WHERE managed_by = 'clawbits' AND agent_id <> 'deleted-agent'
        ORDER BY agent_id, created_at NULLS LAST
        ON CONFLICT DO NOTHING
        """,
        """
        INSERT INTO agent_marks (agent_id, kind)
        SELECT agent_id, 'lobstertalk'
        FROM agents
        WHERE lobstertalk_enabled AND agent_id <> 'deleted-agent'
        ON CONFLICT DO NOTHING
        """,
    ):
        op.execute(statement)


def downgrade() -> None:
    op.drop_table("agent_marks")

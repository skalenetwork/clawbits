"""create mm_channel_events

Adds the ``mm_channel_events`` table for inline non-message events in a
channel timeline. Phase 1 covers ``member.added`` / ``member.removed``;
the schema is shaped to absorb future event types (``channel.renamed``,
``topic.changed``, archive, etc.) via the ``payload`` JSONB column
without a follow-up migration — just extend the check constraint.

Why a separate table from ``mm_posts``: posts carry mutable, post-shaped
state (edits, reactions, pins, threads, attachments, link previews) that
events don't. Keeping events out of ``mm_posts`` means every post-
mutation endpoint stays correct without per-endpoint guards, and event
rows don't pay the cost of carrying always-NULL post columns. The
history endpoint reunites them server-side via UNION ALL ordered by
``created_at`` so the client still sees a single chronological stream.

Identity model mirrors ``mm_posts``: an ``actor_*`` pair for who took the
action (exactly one of human/agent is set, enforced by the actor check),
and a parallel ``subject_*`` pair for the target of the action. NULL
subject means the actor acted on themselves — the renderer uses that to
pick "joined"/"left" over "added X"/"removed X".

DM channels never get events: the emit helper short-circuits on
``channel_type == 'direct'`` so the table never accumulates 1:1 noise.

Revision ID: f4e2a8c91d52
Revises: d8e3f7a2b419
Create Date: 2026-05-28 17:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "f4e2a8c91d52"
down_revision: str | Sequence[str] | None = "d8e3f7a2b419"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mm_channel_events",
        sa.Column("event_id", sa.Integer(), nullable=False),
        sa.Column(
            "channel_id",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
        ),
        sa.Column(
            "event_type",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
        ),
        sa.Column("actor_human_id", sa.Integer(), nullable=True),
        sa.Column(
            "actor_agent_id",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=True,
        ),
        sa.Column("subject_human_id", sa.Integer(), nullable=True),
        sa.Column(
            "subject_agent_id",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=True,
        ),
        sa.Column("payload", JSONB, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.CheckConstraint(
            "event_type IN ('member.added', 'member.removed')",
            name="mm_channel_events_type_check",
        ),
        sa.CheckConstraint(
            "actor_human_id IS NOT NULL OR actor_agent_id IS NOT NULL",
            name="mm_channel_events_actor_check",
        ),
        sa.ForeignKeyConstraint(
            ["channel_id"], ["mm_channels.channel_id"],
        ),
        sa.ForeignKeyConstraint(
            ["actor_human_id"], ["human_users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["actor_agent_id"], ["agents.agent_id"],
        ),
        sa.ForeignKeyConstraint(
            ["subject_human_id"], ["human_users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["subject_agent_id"], ["agents.agent_id"],
        ),
        sa.PrimaryKeyConstraint("event_id"),
    )
    # Composite index drives the history merge: ``WHERE channel_id = ?
    # ORDER BY created_at DESC LIMIT N`` runs from a single seek without
    # touching the heap until the page is paged out.
    op.create_index(
        "ix_mm_channel_events_channel_created",
        "mm_channel_events",
        ["channel_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_mm_channel_events_channel_created",
        table_name="mm_channel_events",
    )
    op.drop_table("mm_channel_events")

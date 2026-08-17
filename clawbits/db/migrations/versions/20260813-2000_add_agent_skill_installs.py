"""create agent_skill_installs + agent_skill_sync_state (the skills sync plane)

The mirror half of the skills library (plan §8, M2). Clawbits never pushes into
an agent: the agent's plugin reports what it has over its existing outbound
lane, exactly as the automations reconciler does for cron.

The M2 client is READ-ONLY — it scans and reports, and has no write path at all.
So in practice this migration only ever produces ``managed_by='external'`` rows
at first: skills the agent already had, whether baked into its image, installed
by an operator over the terminal, or installed by the agent itself when a human
said "install X from ClawHub". The full managed/desired-state column set ships
now anyway, so enabling installs later is code plus a generation bump rather
than a second migration against a table that already has rows.

``UNIQUE(agent_id, slug)`` is deliberately NOT partial. A partial predicate
would permit a tombstone and a live row for the same slug to coexist, making
reconcile ordering load-bearing; a plain unique makes that state impossible.
Note this is the OPPOSITE call from ``uq_skills_org_slug``, which IS partial
because a soft-deleted catalog entry must not burn its name forever.

No data migration: both tables start empty.

Revision ID: a7d3f81c62b9
Revises: f2c9a4d7b103
Create Date: 2026-08-13 20:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a7d3f81c62b9"
down_revision: str | Sequence[str] | None = "f2c9a4d7b103"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "agent_skill_installs",
        sa.Column("install_id", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("org_id", sa.String(), nullable=True),
        sa.Column("skill_id", sa.Text(), nullable=True),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("managed_by", sa.Text(), nullable=False, server_default="external"),
        sa.Column("channel", sa.Text(), nullable=False, server_default="latest"),
        sa.Column("pinned_version_id", sa.String(), nullable=True),
        sa.Column("resolved_version_id", sa.String(), nullable=True),
        sa.Column("desired_content_hash", sa.String(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("desired_generation", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("observed_generation", sa.BigInteger(), nullable=True),
        sa.Column("sync_status", sa.Text(), nullable=False, server_default="requested"),
        sa.Column("sync_error", sa.String(), nullable=True),
        sa.Column("apply_mode", sa.String(), nullable=True),
        sa.Column("reported_version", sa.String(), nullable=True),
        sa.Column("reported_content_hash", sa.String(), nullable=True),
        sa.Column("reported_path", sa.String(), nullable=True),
        sa.Column("reported_root", sa.String(), nullable=True),
        sa.Column("reported_source", sa.String(), nullable=True),
        sa.Column("reported_manifest", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("reported_state", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("schema_version", sa.Text(), nullable=False, server_default="1"),
        sa.Column("plugin_version", sa.String(), nullable=True),
        sa.Column("agent_runtime_version", sa.String(), nullable=True),
        sa.Column("missing_streak", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("missing_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_reported_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("installed_by", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("install_id"),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.agent_id"]),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.org_id"]),
        sa.ForeignKeyConstraint(["skill_id"], ["skills.skill_id"]),
        sa.ForeignKeyConstraint(["installed_by"], ["human_users.id"]),
        sa.CheckConstraint(
            "managed_by IN ('clawbits', 'external')",
            name="agent_skill_installs_managed_check",
        ),
        sa.CheckConstraint(
            "sync_status IN ('requested', 'applied', 'staged', 'failed', 'removing')",
            name="agent_skill_installs_sync_status_check",
        ),
        sa.CheckConstraint(
            "channel IN ('pinned', 'latest')",
            name="agent_skill_installs_channel_check",
        ),
        sa.UniqueConstraint(
            "agent_id", "slug", name="uq_agent_skill_installs_agent_slug"
        ),
    )
    op.create_index("ix_agent_skill_installs_agent", "agent_skill_installs", ["agent_id"])
    op.create_index("ix_agent_skill_installs_org", "agent_skill_installs", ["org_id"])
    op.create_index("ix_agent_skill_installs_skill", "agent_skill_installs", ["skill_id"])

    op.create_table(
        "agent_skill_sync_state",
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("desired_generation", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("paused", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("report_mode", sa.String(), nullable=True),
        sa.Column("skills_root", sa.String(), nullable=True),
        sa.Column("scanned_roots", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("apply_mode", sa.String(), nullable=True),
        sa.Column("prompt_chars_observed", sa.Integer(), nullable=True),
        sa.Column("prompt_budget_observed", sa.Integer(), nullable=True),
        sa.Column("report_truncated", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("plugin_version", sa.String(), nullable=True),
        sa.Column("agent_runtime_version", sa.String(), nullable=True),
        sa.Column("last_reported_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("agent_id"),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.agent_id"]),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("agent_skill_sync_state")
    op.drop_index("ix_agent_skill_installs_skill", table_name="agent_skill_installs")
    op.drop_index("ix_agent_skill_installs_org", table_name="agent_skill_installs")
    op.drop_index("ix_agent_skill_installs_agent", table_name="agent_skill_installs")
    op.drop_table("agent_skill_installs")

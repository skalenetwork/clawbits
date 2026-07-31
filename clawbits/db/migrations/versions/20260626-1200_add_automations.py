"""create automations + automation_runs

Adds the Clawbits automations control-plane tables. Clawbits never schedules
anything itself — OpenClaw's cron engine is the system of record. These tables
hold the operator's *desired* state and a *mirror* of what the agent's plugin
last reported; the plugin reconciles the local gateway cron to ``desired_spec``
over the agent's existing outbound lane. See
``docs/protocol/OPENCLAW_AUTOMATIONS_INTEGRATION_STRATEGY.md``.

``automations`` — one row per automation. ``managed_by='clawbits'`` rows carry a
normalized ``desired_spec`` (an OpenClaw cron create/update payload, NOT a raw
``CronJob``) and are reconciled to it; ``managed_by='external'`` rows are
mirror-only (made via ``openclaw cron`` directly). ``desired_generation`` is a
monotonic per-agent counter bumped on operator intent changes; the unique
``(agent_id, gateway_job_id)`` keeps one Clawbits row per gateway job (NULLs are
distinct in Postgres, so many not-yet-applied rows coexist).

``automation_runs`` — a bounded, de-duplicated projection of OpenClaw
``CronRunLogEntry`` rows the agent self-reports; unique on
``(automation_id, gateway_run_id)`` so re-reporting the same run upserts.

Revision ID: b9e4c1a7f2d8
Revises: f6d2a9c4b71e
Create Date: 2026-06-26 12:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b9e4c1a7f2d8"
down_revision: str | Sequence[str] | None = "f6d2a9c4b71e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "automations",
        sa.Column("automation_id", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("org_id", sa.String(), nullable=True),
        sa.Column(
            "managed_by",
            sa.Text(),
            server_default="clawbits",
            nullable=False,
        ),
        sa.Column(
            "desired_spec",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "desired_generation",
            sa.BigInteger(),
            server_default="0",
            nullable=False,
        ),
        sa.Column("spec_hash", sa.String(), nullable=True),
        sa.Column(
            "reported_spec",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "reported_state",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("observed_generation", sa.BigInteger(), nullable=True),
        sa.Column(
            "schema_version",
            sa.Text(),
            server_default="1",
            nullable=False,
        ),
        sa.Column("openclaw_version", sa.String(), nullable=True),
        sa.Column("plugin_version", sa.String(), nullable=True),
        sa.Column(
            "sync_status",
            sa.Text(),
            server_default="requested",
            nullable=False,
        ),
        sa.Column("sync_error", sa.String(), nullable=True),
        sa.Column("gateway_job_id", sa.String(), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("missing_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_reported_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
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
        sa.CheckConstraint(
            "managed_by IN ('clawbits', 'external')",
            name="automations_managed_by_check",
        ),
        sa.CheckConstraint(
            "sync_status IN ('requested', 'applied', 'failed', 'removing')",
            name="automations_sync_status_check",
        ),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.agent_id"]),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.org_id"]),
        sa.ForeignKeyConstraint(["created_by"], ["human_users.id"]),
        sa.PrimaryKeyConstraint("automation_id"),
        sa.UniqueConstraint(
            "agent_id", "gateway_job_id", name="uq_automations_agent_job"
        ),
    )
    op.create_index("ix_automations_agent", "automations", ["agent_id"])
    op.create_index("ix_automations_org", "automations", ["org_id"])

    op.create_table(
        "automation_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("automation_id", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("gateway_job_id", sa.String(), nullable=True),
        sa.Column("gateway_run_id", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "summary",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "diagnostics",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(
            ["automation_id"], ["automations.automation_id"]
        ),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.agent_id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "automation_id", "gateway_run_id", name="uq_automation_runs_run"
        ),
    )
    op.create_index(
        "ix_automation_runs_automation",
        "automation_runs",
        ["automation_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_automation_runs_automation",
        table_name="automation_runs",
    )
    op.drop_table("automation_runs")
    op.drop_index("ix_automations_org", table_name="automations")
    op.drop_index("ix_automations_agent", table_name="automations")
    op.drop_table("automations")

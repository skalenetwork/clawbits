"""create agent_usage_events + agent_usage_daily

Adds the agent AI-usage tracking tables. The agent's OpenClaw plugin
self-reports per-model-call token usage over its outbound ``api_key`` lane
(telemetry-class, billing-exempt); Clawbits is a passive store. See
``docs/protocol/AGENT_USAGE_TRACKING_PLAN.md``.

``agent_usage_events`` — the idempotent dedup ledger, unique on
``(agent_id, event_id)`` so at-least-once reporting never double-counts.
Bounded: rows older than the retention window are pruned, and ingest rejects
events outside the accepted time window (older than retention, or beyond the
future-skew bound — ``occurred_at`` is client-supplied).

``agent_usage_daily`` — the permanent per-day rollup the dashboard reads,
folded from newly-inserted events only. Every PK column is NOT NULL
(``provider`` uses the ``"unknown"`` sentinel): with a nullable member NULLs
would be pairwise distinct and the ON-CONFLICT fold would insert a fresh row
per event instead of accumulating.

Revision ID: a7d3f9c2e8b4
Revises: f0e1d2c3b4a5
Create Date: 2026-07-20 12:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7d3f9c2e8b4"
down_revision: str | Sequence[str] | None = "f0e1d2c3b4a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_usage_events",
        sa.Column("usage_event_id", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("org_id", sa.String(), nullable=True),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column(
            "provider",
            sa.Text(),
            server_default="unknown",
            nullable=False,
        ),
        sa.Column(
            "input_tokens", sa.BigInteger(), server_default="0", nullable=False
        ),
        sa.Column(
            "output_tokens", sa.BigInteger(), server_default="0", nullable=False
        ),
        sa.Column(
            "cache_read_tokens",
            sa.BigInteger(),
            server_default="0",
            nullable=False,
        ),
        sa.Column(
            "cache_write_tokens",
            sa.BigInteger(),
            server_default="0",
            nullable=False,
        ),
        sa.Column("cost_usd", sa.Numeric(18, 6), nullable=True),
        sa.Column("currency", sa.Text(), server_default="USD", nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column(
            "reported_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.CheckConstraint(
            "source IN ('hook', 'jsonl')",
            name="agent_usage_events_source_check",
        ),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.agent_id"]),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.org_id"]),
        sa.PrimaryKeyConstraint("usage_event_id"),
        sa.UniqueConstraint("agent_id", "event_id", name="uq_agent_usage_event"),
    )
    op.create_index(
        "ix_agent_usage_events_agent_time",
        "agent_usage_events",
        ["agent_id", "occurred_at"],
    )
    op.create_index(
        "ix_agent_usage_events_org_time",
        "agent_usage_events",
        ["org_id", "occurred_at"],
    )

    op.create_table(
        "agent_usage_daily",
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("usage_date", sa.Date(), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("org_id", sa.String(), nullable=True),
        sa.Column(
            "input_tokens", sa.BigInteger(), server_default="0", nullable=False
        ),
        sa.Column(
            "output_tokens", sa.BigInteger(), server_default="0", nullable=False
        ),
        sa.Column(
            "cache_read_tokens",
            sa.BigInteger(),
            server_default="0",
            nullable=False,
        ),
        sa.Column(
            "cache_write_tokens",
            sa.BigInteger(),
            server_default="0",
            nullable=False,
        ),
        sa.Column("cost_usd", sa.Numeric(18, 6), nullable=True),
        sa.Column(
            "call_count", sa.BigInteger(), server_default="0", nullable=False
        ),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.agent_id"]),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.org_id"]),
        sa.PrimaryKeyConstraint("agent_id", "usage_date", "model", "provider"),
    )
    op.create_index(
        "ix_agent_usage_daily_org_date",
        "agent_usage_daily",
        ["org_id", "usage_date"],
    )


def downgrade() -> None:
    op.drop_index("ix_agent_usage_daily_org_date", table_name="agent_usage_daily")
    op.drop_table("agent_usage_daily")
    op.drop_index(
        "ix_agent_usage_events_org_time", table_name="agent_usage_events"
    )
    op.drop_index(
        "ix_agent_usage_events_agent_time", table_name="agent_usage_events"
    )
    op.drop_table("agent_usage_events")

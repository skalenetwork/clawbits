"""add email_deliveries, the keyed outbound email outbox

One row per (agent_id, Idempotency-Key) POST /email/send with its SMTP delivery state. The row
holds a hash of the request and a stable Message-ID, never the body or attachments.

Revision ID: e7322b2aed49
Revises: 8a1c4e9b2d70
Create Date: 2026-09-21 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7322b2aed49"
down_revision: str | Sequence[str] | None = "8a1c4e9b2d70"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "email_deliveries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("payload_hash", sa.Text(), nullable=False),
        sa.Column("from_addr", sa.Text(), nullable=False),
        sa.Column("to_addr", sa.Text(), nullable=False),
        sa.Column("subject", sa.Text(), nullable=False),
        sa.Column("message_id", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), server_default="queued", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "state IN ('queued', 'attempting', 'accepted', 'retry_wait', 'failed', 'unknown')",
            name="email_deliveries_state_check",
        ),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.agent_id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("agent_id", "idempotency_key", name="uq_email_deliveries_agent_key"),
    )


def downgrade() -> None:
    op.drop_table("email_deliveries")

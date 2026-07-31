"""add human_connectors for universal third-party identity links

Stores per-human connector profiles (GitHub first; Notion/Gmail later)
as non-secret metadata only — never OAuth tokens. See
``clawbits.connectors`` and ``docs/protocol/GITHUB_INTEGRATION_SPEC.md`` §3.

Revision ID: b8e4a1c7d902
Revises: ae6015fc1943
Create Date: 2026-07-24 12:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b8e4a1c7d902"
down_revision: str | Sequence[str] | None = "ae6015fc1943"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "human_connectors",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("human_id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("external_id", sa.String(), nullable=False),
        sa.Column("handle", sa.String(), nullable=True),
        sa.Column("display_name", sa.String(), nullable=True),
        sa.Column("avatar_url", sa.String(), nullable=True),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "connected_at",
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
        sa.ForeignKeyConstraint(
            ["human_id"],
            ["human_users.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "human_id", "provider",
            name="uq_human_connectors_human_provider",
        ),
        sa.UniqueConstraint(
            "provider", "external_id",
            name="uq_human_connectors_provider_external",
        ),
    )
    op.create_index(
        "ix_human_connectors_human_id",
        "human_connectors",
        ["human_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_human_connectors_human_id", table_name="human_connectors")
    op.drop_table("human_connectors")

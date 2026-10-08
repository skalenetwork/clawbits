"""add reported SKILL.md, adopt takeover and bundled skills

``agent_skill_installs`` gains the raw SKILL.md the agent reported for its
current ``reported_content_hash`` (with the reason when it sent none) and the
``takeover`` flag adopt sets so the client may replace an unmanaged directory
of the same slug. ``agent_skill_sync_state`` gains ``bundled``, OpenClaw's
built-in skills. All start empty; nothing to backfill.

Revision ID: 3cb9892ce879
Revises: fe1d6327aa11
Create Date: 2026-10-07 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "3cb9892ce879"
down_revision: str | Sequence[str] | None = "fe1d6327aa11"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_skill_installs",
        sa.Column("takeover", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("agent_skill_installs", sa.Column("reported_skill_md", sa.Text(), nullable=True))
    op.add_column(
        "agent_skill_installs", sa.Column("reported_skill_md_omitted", sa.String(), nullable=True)
    )
    op.add_column("agent_skill_sync_state", sa.Column("bundled", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("agent_skill_sync_state", "bundled")
    op.drop_column("agent_skill_installs", "reported_skill_md_omitted")
    op.drop_column("agent_skill_installs", "reported_skill_md")
    op.drop_column("agent_skill_installs", "takeover")

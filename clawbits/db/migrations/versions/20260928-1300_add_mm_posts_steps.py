"""add mm_posts.steps

Adds a JSONB ``steps`` column to ``mm_posts``: the finished turn an agent's reply came from, as its plugin
reported it live (tool calls keyed by the engine's tool call id, plus the agent's narration), so the trace
survives a reload and reaches other devices. NULL for human posts and replies from older plugins.

Revision ID: 17a720869b47
Revises: 8a1c4e9b2d70
Create Date: 2026-09-28 13:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "17a720869b47"
down_revision: str | Sequence[str] | None = "8a1c4e9b2d70"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("mm_posts", sa.Column("steps", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("mm_posts", "steps")

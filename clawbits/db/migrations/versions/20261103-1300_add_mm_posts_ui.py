"""add mm_posts.ui and mm_posts.ui_action

``ui`` is an agent's A2UI v1.0 surface (the ``createSurface`` envelope plus rev, once and closed);
its ``message`` holds the server's text fallback. ``ui_action`` is the A2UI action a human post sends
to the surface it replies to. Both NULL on every other post.

Revision ID: 9f208d1955aa
Revises: 4b9e2f7c1a63
Create Date: 2026-11-03 13:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "9f208d1955aa"
down_revision: str | Sequence[str] | None = "4b9e2f7c1a63"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("mm_posts", sa.Column("ui", JSONB, nullable=True))
    op.add_column("mm_posts", sa.Column("ui_action", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("mm_posts", "ui_action")
    op.drop_column("mm_posts", "ui")

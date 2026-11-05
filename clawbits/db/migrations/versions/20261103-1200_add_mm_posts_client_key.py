"""mm_posts.client_key: an agent's idempotency key for durable reply delivery

The plugin keys each final send by OpenClaw's durable delivery intent, so a send
replayed after a crash or an ambiguous failure returns the post it created instead
of posting the reply twice.

Revision ID: 4b9e2f7c1a63
Revises: c3404d368e23
Create Date: 2026-11-03 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4b9e2f7c1a63"
down_revision: str | Sequence[str] | None = "c3404d368e23"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("mm_posts", sa.Column("client_key", sa.Text(), nullable=True))
    op.create_index(
        "uq_mm_posts_channel_client_key",
        "mm_posts",
        ["channel_id", "client_key"],
        unique=True,
        postgresql_where=sa.text("client_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_mm_posts_channel_client_key", table_name="mm_posts")
    op.drop_column("mm_posts", "client_key")

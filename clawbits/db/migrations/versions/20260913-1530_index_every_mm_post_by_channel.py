"""index every mm post by channel

Revision ID: 700d156ea6db
Revises: 0006d9316d3e
Create Date: 2026-09-13 15:30:43.733761

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "700d156ea6db"
down_revision: str | Sequence[str] | None = "0006d9316d3e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index("ix_mm_posts_channel_post", table_name="mm_posts")
    op.create_index("ix_mm_posts_channel_post", "mm_posts", ["channel_id", "post_id"])


def downgrade() -> None:
    op.drop_index("ix_mm_posts_channel_post", table_name="mm_posts")
    op.create_index(
        "ix_mm_posts_channel_post",
        "mm_posts",
        ["channel_id", "post_id"],
        postgresql_where=sa.text("status = 'published'"),
    )

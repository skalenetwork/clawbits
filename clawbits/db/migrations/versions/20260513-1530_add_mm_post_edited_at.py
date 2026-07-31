"""add mm_posts.edited_at

Adds a nullable ``edited_at`` column to ``mm_posts``. NULL means the post
has never been edited; a timestamp means the human author rewrote the
message at that time. Tracked separately from ``updated_at`` because the
streaming-PATCH and draft-approval paths already touch ``updated_at`` for
reasons unrelated to user-visible content changes.

Revision ID: a2d6f81c5b97
Revises: 9c5f7e3b8a14
Create Date: 2026-05-13 15:30:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'a2d6f81c5b97'
down_revision: str | Sequence[str] | None = '9c5f7e3b8a14'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('mm_posts') as batch:
        batch.add_column(
            sa.Column('edited_at', sa.DateTime(timezone=True), nullable=True)
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('mm_posts') as batch:
        batch.drop_column('edited_at')

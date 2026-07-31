"""add mm_posts.parent_post_id

Adds an optional self-referential parent pointer to ``mm_posts`` so a
post can quote another post in the same channel (Telegram-style inline
replies). NULL for top-level posts. Same-channel and visible-status
checks live in the write path, not the schema.

Revision ID: 7b4e2d9a1c83
Revises: 6a1c2f4b9e83
Create Date: 2026-05-13 10:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '7b4e2d9a1c83'
down_revision: str | Sequence[str] | None = '6a1c2f4b9e83'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('mm_posts') as batch:
        batch.add_column(
            sa.Column('parent_post_id', sa.Integer(), nullable=True)
        )
        batch.create_foreign_key(
            'fk_mm_posts_parent',
            'mm_posts',
            ['parent_post_id'], ['post_id'],
        )
    op.create_index(
        'ix_mm_posts_parent_post_id', 'mm_posts', ['parent_post_id']
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_mm_posts_parent_post_id', table_name='mm_posts')
    with op.batch_alter_table('mm_posts') as batch:
        batch.drop_constraint('fk_mm_posts_parent', type_='foreignkey')
        batch.drop_column('parent_post_id')

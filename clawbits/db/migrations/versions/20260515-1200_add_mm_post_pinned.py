"""add mm_posts.pinned_at + pinned_by_human_id

Adds Slack/Discord-style pinned messages on channel posts. NULL means
the post is not pinned; a timestamp means it's currently pinned. We use
a single column (rather than a separate join table) because a post is
either pinned or not — there's no per-user pin state. A partial index on
``pinned_at`` keeps the "list pinned messages in this channel" query
cheap regardless of how big ``mm_posts`` grows.

Revision ID: c7a1d4e92f08
Revises: b3f4e7d28c45
Create Date: 2026-05-15 12:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'c7a1d4e92f08'
down_revision: str | Sequence[str] | None = 'b3f4e7d28c45'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('mm_posts') as batch:
        batch.add_column(
            sa.Column('pinned_at', sa.DateTime(timezone=True), nullable=True)
        )
        batch.add_column(
            sa.Column('pinned_by_human_id', sa.Integer(), nullable=True)
        )
        batch.create_foreign_key(
            'fk_mm_posts_pinned_by_human_id',
            'human_users',
            ['pinned_by_human_id'],
            ['id'],
        )
    op.create_index(
        'ix_mm_posts_channel_pinned',
        'mm_posts',
        ['channel_id', sa.text('pinned_at DESC')],
        postgresql_where=sa.text('pinned_at IS NOT NULL'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_mm_posts_channel_pinned', table_name='mm_posts')
    with op.batch_alter_table('mm_posts') as batch:
        batch.drop_constraint('fk_mm_posts_pinned_by_human_id', type_='foreignkey')
        batch.drop_column('pinned_by_human_id')
        batch.drop_column('pinned_at')

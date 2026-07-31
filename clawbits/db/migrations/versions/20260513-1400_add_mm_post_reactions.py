"""add mm_post_reactions

Adds Slack/Discord-style emoji reactions on channel posts. Each row is one
(post, emoji, member) tuple; toggling inserts or deletes a single row.
Aggregation into ``{emoji, count, members}`` happens in the read path.

Revision ID: 9c5f7e3b8a14
Revises: 7b4e2d9a1c83
Create Date: 2026-05-13 14:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '9c5f7e3b8a14'
down_revision: str | Sequence[str] | None = '7b4e2d9a1c83'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'mm_post_reactions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('post_id', sa.Integer(), nullable=False),
        sa.Column('emoji', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column('agent_id', sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column('human_id', sa.Integer(), nullable=True),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=True,
        ),
        sa.CheckConstraint(
            'agent_id IS NOT NULL OR human_id IS NOT NULL',
            name='mm_post_reactions_member_check',
        ),
        sa.ForeignKeyConstraint(['post_id'], ['mm_posts.post_id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['agent_id'], ['agents.agent_id']),
        sa.ForeignKeyConstraint(['human_id'], ['human_users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'post_id', 'emoji', 'human_id',
            name='uq_mm_post_reactions_post_emoji_human',
        ),
        sa.UniqueConstraint(
            'post_id', 'emoji', 'agent_id',
            name='uq_mm_post_reactions_post_emoji_agent',
        ),
    )
    op.create_index(
        'ix_mm_post_reactions_post_id', 'mm_post_reactions', ['post_id']
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_mm_post_reactions_post_id', table_name='mm_post_reactions')
    op.drop_table('mm_post_reactions')

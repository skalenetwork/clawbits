"""add mm_files

First-class file attachments for ``mm_posts``. A row is created when the
upload URL is issued (``status='pending'``), transitions to ``'uploaded'``
once the client confirms the R2 PUT, and is bound to a post by setting
``post_id`` on post create or edit. Orphan rows (``post_id IS NULL`` older
than 24h) are GC'd out-of-band along with their R2 objects.

Revision ID: 5e8d7f2a3b91
Revises: a2d6f81c5b97
Create Date: 2026-05-13 17:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '5e8d7f2a3b91'
down_revision: str | Sequence[str] | None = 'a2d6f81c5b97'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'mm_files',
        sa.Column('file_id', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column('channel_id', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column('post_id', sa.Integer(), nullable=True),
        sa.Column('uploader_human_id', sa.Integer(), nullable=True),
        sa.Column('uploader_agent_id', sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column('object_key', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column('filename', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column('content_type', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column('size_bytes', sa.BigInteger(), nullable=False),
        sa.Column('sha256', sqlmodel.sql.sqltypes.AutoString(), nullable=True),
        sa.Column('width', sa.Integer(), nullable=True),
        sa.Column('height', sa.Integer(), nullable=True),
        sa.Column('duration_ms', sa.Integer(), nullable=True),
        sa.Column(
            'thumbnail_object_key',
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=True,
        ),
        sa.Column('status', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=True,
        ),
        sa.Column('uploaded_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            'uploader_human_id IS NOT NULL OR uploader_agent_id IS NOT NULL',
            name='mm_files_uploader_check',
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'uploaded', 'failed', 'deleted')",
            name='mm_files_status_check',
        ),
        sa.ForeignKeyConstraint(
            ['channel_id'], ['mm_channels.channel_id'],
        ),
        sa.ForeignKeyConstraint(
            ['post_id'], ['mm_posts.post_id'], ondelete='SET NULL',
        ),
        sa.ForeignKeyConstraint(
            ['uploader_human_id'], ['human_users.id'],
        ),
        sa.ForeignKeyConstraint(
            ['uploader_agent_id'], ['agents.agent_id'],
        ),
        sa.PrimaryKeyConstraint('file_id'),
    )
    op.create_index('ix_mm_files_channel_id', 'mm_files', ['channel_id'])
    op.create_index('ix_mm_files_post_id', 'mm_files', ['post_id'])
    # Composite index for the orphan GC scan:
    #   WHERE post_id IS NULL AND status = 'pending' AND created_at < ...
    op.create_index(
        'ix_mm_files_gc',
        'mm_files',
        ['status', 'post_id', 'created_at'],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_mm_files_gc', table_name='mm_files')
    op.drop_index('ix_mm_files_post_id', table_name='mm_files')
    op.drop_index('ix_mm_files_channel_id', table_name='mm_files')
    op.drop_table('mm_files')

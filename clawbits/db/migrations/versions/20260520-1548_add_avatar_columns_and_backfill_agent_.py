"""add avatar columns to users / agents / channels

Adds metadata used by :mod:`clawbits.avatars` to track which avatar
each user/agent/channel currently has. The actual avatar SVGs live in
R2 under ``avatars/{type}/{id}/v{version}.svg`` and are produced by a
separate backfill pass — this migration only widens the schema.

After this migration applies, run::

    uv run python -m clawbits.avatars.backfill

to populate ``agents.agent_character`` for existing rows and upload
the generated SVG for every user / agent / channel. New entities
created after this migration get their avatar via the post-commit
hook in :mod:`clawbits.fastapi.clawbits_server` (see the
``_ensure_*_avatar_after_commit`` helpers).

Revision ID: 006f50df7b37
Revises: c7a1d4e92f08
Create Date: 2026-05-20 15:48:46.600935

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '006f50df7b37'
down_revision: str | Sequence[str] | None = 'c7a1d4e92f08'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('agents', sa.Column('avatar_kind', sa.Text(), server_default='generated', nullable=False))
    op.add_column('agents', sa.Column('avatar_version', sa.Integer(), server_default='1', nullable=False))
    op.add_column('agents', sa.Column('agent_character', sa.Text(), server_default='', nullable=False))
    op.add_column('human_users', sa.Column('avatar_kind', sa.Text(), server_default='generated', nullable=False))
    op.add_column('human_users', sa.Column('avatar_version', sa.Integer(), server_default='1', nullable=False))
    op.add_column('mm_channels', sa.Column('avatar_version', sa.Integer(), server_default='1', nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('mm_channels', 'avatar_version')
    op.drop_column('human_users', 'avatar_version')
    op.drop_column('human_users', 'avatar_kind')
    op.drop_column('agents', 'agent_character')
    op.drop_column('agents', 'avatar_version')
    op.drop_column('agents', 'avatar_kind')

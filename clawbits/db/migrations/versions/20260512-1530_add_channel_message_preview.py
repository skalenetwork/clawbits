"""add channel message preview

Adds denormalised last-message preview fields to ``mm_channels`` so the
sidebar can render a Telegram-style row (channel/DM name, preview text,
last-poster avatar) with one row read instead of a subquery-per-channel.

Fields are NULL for pre-existing channels — previews populate as new
activity arrives. No backfill by design.

Revision ID: 42278ec34755
Revises: f01b85892c52
Create Date: 2026-05-12 15:30:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '42278ec34755'
down_revision: str | Sequence[str] | None = 'f01b85892c52'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('mm_channels') as batch:
        batch.add_column(sa.Column('last_message_text', sqlmodel.sql.sqltypes.AutoString(), nullable=True))
        batch.add_column(sa.Column('last_message_author_human_id', sa.Integer(), nullable=True))
        batch.add_column(sa.Column('last_message_author_agent_id', sqlmodel.sql.sqltypes.AutoString(), nullable=True))
        batch.add_column(sa.Column('last_message_author_display_name', sqlmodel.sql.sqltypes.AutoString(), nullable=True))
        batch.create_foreign_key(
            'fk_mm_channels_last_msg_human',
            'human_users',
            ['last_message_author_human_id'], ['id'],
        )
        batch.create_foreign_key(
            'fk_mm_channels_last_msg_agent',
            'agents',
            ['last_message_author_agent_id'], ['agent_id'],
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('mm_channels') as batch:
        batch.drop_constraint('fk_mm_channels_last_msg_agent', type_='foreignkey')
        batch.drop_constraint('fk_mm_channels_last_msg_human', type_='foreignkey')
        batch.drop_column('last_message_author_display_name')
        batch.drop_column('last_message_author_agent_id')
        batch.drop_column('last_message_author_human_id')
        batch.drop_column('last_message_text')

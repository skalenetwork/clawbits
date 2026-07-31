"""normalize mm_channels.last_message_text to TEXT

The column was originally added as unbounded VARCHAR (via sqlmodel's
``AutoString``). Postgres treats unbounded VARCHAR identically to TEXT
for storage and behaviour, but ``alembic check`` with
``compare_type=True`` flags the difference on every run depending on
which type the introspector returns. Normalize to TEXT so the model
declaration (``sa.Text``) and the DB schema agree across fresh deploys
and pre-existing environments.

Revision ID: b3f4e7d28c45
Revises: 5e8d7f2a3b91
Create Date: 2026-05-13 17:30:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'b3f4e7d28c45'
down_revision: str | Sequence[str] | None = '5e8d7f2a3b91'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('mm_channels') as batch:
        batch.alter_column(
            'last_message_text',
            existing_type=sa.VARCHAR(),
            type_=sa.Text(),
            existing_nullable=True,
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('mm_channels') as batch:
        batch.alter_column(
            'last_message_text',
            existing_type=sa.Text(),
            type_=sa.VARCHAR(),
            existing_nullable=True,
        )

"""drop agents.agent_character

The column was used by the legacy in-house marble synth (avatar v1-v3).
Since v4 (DiceBear bottts-neutral) the seed is just ``agent_id`` — no
character look-up. Confirmed unused at every read site before drop.

Revision ID: d695fc82a370
Revises: 006f50df7b37
Create Date: 2026-05-21 16:36:52.127275

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'd695fc82a370'
down_revision: str | Sequence[str] | None = '006f50df7b37'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_column('agents', 'agent_character')


def downgrade() -> None:
    """Downgrade schema."""
    op.add_column(
        'agents',
        sa.Column('agent_character', sa.Text(), server_default='', nullable=False),
    )

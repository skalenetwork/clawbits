"""add human_users.last_seen_at

Adds ``last_seen_at`` to ``human_users`` so the UI can render "last seen
2h ago" tooltips next to offline presence dots. The live online/idle/
offline state itself lives in Redis (ephemeral); this column captures
the moment a user transitioned away (or the most recent heartbeat,
written at most once every 5 minutes while online).

Nullable for pre-existing rows — backfill happens organically as users
sign in next.

Revision ID: 6a1c2f4b9e83
Revises: 42278ec34755
Create Date: 2026-05-13 09:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '6a1c2f4b9e83'
down_revision: str | Sequence[str] | None = '42278ec34755'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('human_users') as batch:
        batch.add_column(
            sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True)
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('human_users') as batch:
        batch.drop_column('last_seen_at')

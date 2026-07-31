"""rename agent_owners to agent_orgs

The relationship row stores an org that owns an agent. The table and its
unique constraint are renamed to make the entity (org) explicit; the
``is_primary`` flag continues to identify the primary owner.

Revision ID: a1b2c3d4e5f6
Revises: b1a3bf9c8dea
Create Date: 2026-05-26 12:00:00.000000

"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: str | Sequence[str] | None = 'b1a3bf9c8dea'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.rename_table('agent_owners', 'agent_orgs')
    op.execute(
        'ALTER TABLE agent_orgs '
        'RENAME CONSTRAINT uq_agent_owners_agent_org '
        'TO uq_agent_orgs_agent_org'
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(
        'ALTER TABLE agent_orgs '
        'RENAME CONSTRAINT uq_agent_orgs_agent_org '
        'TO uq_agent_owners_agent_org'
    )
    op.rename_table('agent_orgs', 'agent_owners')

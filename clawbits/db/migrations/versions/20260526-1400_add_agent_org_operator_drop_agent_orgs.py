"""add agents.org_id + agents.operator_id, drop agent_orgs

Collapses the agent_orgs join table into single-org columns on ``agents``.
Each agent now belongs to exactly one org and has at most one operator
(the human who approved the signup). Both columns are nullable so legacy
rows that pre-date the consolidation can survive without a backfill source.

Backfill rules:
- ``org_id`` ← the ``is_primary=True`` row in ``agent_orgs`` (or any row
  if no primary is marked).
- ``operator_id`` ← the most recent ``status='approved'`` row in
  ``agent_signup_requests.reviewed_by``.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-05-26 14:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'b2c3d4e5f6a7'
down_revision: str | Sequence[str] | None = 'a1b2c3d4e5f6'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'agents',
        sa.Column('org_id', sqlmodel.sql.sqltypes.AutoString(), nullable=True),
    )
    op.add_column(
        'agents',
        sa.Column('operator_id', sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        'fk_agents_org_id_organizations',
        'agents', 'organizations',
        ['org_id'], ['org_id'],
    )
    op.create_foreign_key(
        'fk_agents_operator_id_human_users',
        'agents', 'human_users',
        ['operator_id'], ['id'],
    )

    # challenge_sessions: carry the initiating human so the signup-commit
    # path can record the operator on the new agent.
    op.add_column(
        'challenge_sessions',
        sa.Column('human_id', sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        'fk_challenge_sessions_human_id_human_users',
        'challenge_sessions', 'human_users',
        ['human_id'], ['id'],
    )

    # Backfill org_id from agent_orgs. Prefer the row flagged is_primary;
    # fall back to any row.
    op.execute(
        """
        UPDATE agents a
        SET org_id = sub.org_id
        FROM (
            SELECT DISTINCT ON (agent_id) agent_id, org_id
            FROM agent_orgs
            ORDER BY agent_id, is_primary DESC, created_at ASC
        ) sub
        WHERE a.agent_id = sub.agent_id
        """
    )

    # Backfill operator_id from the most recent approved signup request.
    op.execute(
        """
        UPDATE agents a
        SET operator_id = sub.reviewed_by
        FROM (
            SELECT DISTINCT ON (agent_id) agent_id, reviewed_by
            FROM agent_signup_requests
            WHERE status = 'approved' AND reviewed_by IS NOT NULL
            ORDER BY agent_id, reviewed_at DESC
        ) sub
        WHERE a.agent_id = sub.agent_id
        """
    )

    op.drop_table('agent_orgs')


def downgrade() -> None:
    """Downgrade schema."""
    op.create_table(
        'agent_orgs',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('agent_id', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column('org_id', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column('is_primary', sa.Boolean(), nullable=False),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(['agent_id'], ['agents.agent_id']),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.org_id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('agent_id', 'org_id', name='uq_agent_orgs_agent_org'),
    )
    # Best-effort re-population: each agent that still has an org_id becomes
    # a single is_primary=True row. Operator linkage cannot be restored.
    op.execute(
        """
        INSERT INTO agent_orgs (agent_id, org_id, is_primary)
        SELECT agent_id, org_id, TRUE
        FROM agents
        WHERE org_id IS NOT NULL
        """
    )
    op.drop_constraint(
        'fk_challenge_sessions_human_id_human_users',
        'challenge_sessions',
        type_='foreignkey',
    )
    op.drop_column('challenge_sessions', 'human_id')
    op.drop_constraint(
        'fk_agents_operator_id_human_users', 'agents', type_='foreignkey'
    )
    op.drop_constraint(
        'fk_agents_org_id_organizations', 'agents', type_='foreignkey'
    )
    op.drop_column('agents', 'operator_id')
    op.drop_column('agents', 'org_id')

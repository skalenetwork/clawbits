"""add reef_role_policies and reef_role_members

Who in an org may declare agents from each reef role: everyone, the selected members, or no one. A role
with no policy row stays open to everyone, so existing orgs are unchanged.

Revision ID: fe1d6327aa11
Revises: b4eb14393b0e
Create Date: 2026-10-05 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "fe1d6327aa11"
down_revision: str | Sequence[str] | None = "b4eb14393b0e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reef_role_policies",
        sa.Column("org_id", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("mode", sa.String(), nullable=False),
        sa.CheckConstraint("mode IN ('everyone', 'selected', 'off')", name="reef_role_policies_mode_check"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.org_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("org_id", "role"),
    )
    op.create_table(
        "reef_role_members",
        sa.Column("org_id", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("human_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["org_id", "human_id"],
            ["org_members.org_id", "org_members.human_id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("org_id", "role", "human_id"),
    )


def downgrade() -> None:
    op.drop_table("reef_role_members")
    op.drop_table("reef_role_policies")

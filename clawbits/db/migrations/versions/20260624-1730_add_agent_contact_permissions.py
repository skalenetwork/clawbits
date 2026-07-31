"""create agent_contact_permissions

Adds the ``agent_contact_permissions`` table — the operator-managed allowlist
of who may contact an agent. Contact is **closed by default**: with no row, a
principal (a human or another agent) can neither open a DM with the agent nor
``@``-tag it in a channel. The agent's operator is always implicitly allowed
and is never stored here.

Each row names exactly one principal (``human_id`` XOR ``principal_agent_id``)
and carries two independently-toggled surfaces — ``can_dm`` and ``can_tag``.

Note: this migration does NOT backfill existing DM/channel relationships, so
pre-existing access goes dark until an operator (or org owner) re-grants it.

Revision ID: c3f7a1e2d904
Revises: 7b9d1f4a6c20
Create Date: 2026-06-24 17:30:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3f7a1e2d904"
down_revision: str | Sequence[str] | None = "7b9d1f4a6c20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_contact_permissions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("human_id", sa.Integer(), nullable=True),
        sa.Column("principal_agent_id", sa.String(), nullable=True),
        sa.Column(
            "can_dm",
            sa.Boolean(),
            server_default=sa.false(),
            nullable=False,
        ),
        sa.Column(
            "can_tag",
            sa.Boolean(),
            server_default=sa.false(),
            nullable=False,
        ),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.CheckConstraint(
            "(human_id IS NULL) <> (principal_agent_id IS NULL)",
            name="agent_contact_perms_principal_check",
        ),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.agent_id"]),
        sa.ForeignKeyConstraint(["human_id"], ["human_users.id"]),
        sa.ForeignKeyConstraint(["principal_agent_id"], ["agents.agent_id"]),
        sa.ForeignKeyConstraint(["created_by"], ["human_users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "agent_id", "human_id", name="uq_agent_contact_perms_agent_human"
        ),
        sa.UniqueConstraint(
            "agent_id",
            "principal_agent_id",
            name="uq_agent_contact_perms_agent_principal",
        ),
    )
    op.create_index(
        "ix_agent_contact_perms_agent",
        "agent_contact_permissions",
        ["agent_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_agent_contact_perms_agent",
        table_name="agent_contact_permissions",
    )
    op.drop_table("agent_contact_permissions")

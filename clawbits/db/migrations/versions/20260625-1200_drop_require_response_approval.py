"""drop agents.require_response_approval

The per-agent response-approval setting (agent replies held as drafts until the
operator approved them) and the matching tag-approval hold were removed in
favour of the contact-permission system: who may contact an agent is now the
only gate, and permitted messages publish immediately. This drops the now-unused
column.

Revision ID: d4e8b1c509a7
Revises: c3f7a1e2d904
Create Date: 2026-06-25 12:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4e8b1c509a7"
down_revision: str | Sequence[str] | None = "c3f7a1e2d904"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("agents", "require_response_approval")


def downgrade() -> None:
    op.add_column(
        "agents",
        sa.Column(
            "require_response_approval",
            sa.Boolean(),
            server_default=sa.true(),
            nullable=False,
        ),
    )

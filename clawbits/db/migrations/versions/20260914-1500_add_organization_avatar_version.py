"""add organizations.avatar_version

NULL means the org has no uploaded avatar.

Revision ID: e7b3d91c4a08
Revises: c4e1a9b27d53
Create Date: 2026-09-14 15:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7b3d91c4a08"
down_revision: str | Sequence[str] | None = "c4e1a9b27d53"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("organizations", sa.Column("avatar_version", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("organizations", "avatar_version")

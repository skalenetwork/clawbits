"""add mcp_app_resources

Stores each MCP App's ``ui://`` document once, with the CSP origins its server declared, keyed by their content
hash. A post's step keeps only the hash, so an App that renders many tool calls is stored once.

Revision ID: 3e9c2b7d5a14
Revises: 17a720869b47
Create Date: 2026-09-29 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "3e9c2b7d5a14"
down_revision: str | Sequence[str] | None = "17a720869b47"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mcp_app_resources",
        sa.Column("resource", sa.Text, primary_key=True),
        sa.Column("html", sa.Text, nullable=False),
        sa.Column("csp", JSONB, nullable=False),
    )


def downgrade() -> None:
    op.drop_table("mcp_app_resources")

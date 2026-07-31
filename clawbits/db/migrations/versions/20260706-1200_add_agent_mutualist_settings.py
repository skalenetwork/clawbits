"""add agent mutualist settings

Revision ID: 8f3a5c1d9e42
Revises: c7e2b9a4f1d3
Create Date: 2026-07-06 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8f3a5c1d9e42"
down_revision: str | Sequence[str] | None = "c7e2b9a4f1d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.add_column(
            sa.Column(
                "mutualist_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )
        batch.add_column(sa.Column("mutualist_ollama_host", sa.Text(), nullable=True))
        batch.add_column(sa.Column("mutualist_ollama_model", sa.Text(), nullable=True))
        batch.add_column(
            sa.Column(
                "mutualist_interval_seconds",
                sa.Integer(),
                nullable=False,
                server_default="60",
            )
        )
        batch.add_column(
            sa.Column(
                "mutualist_message_limit",
                sa.Integer(),
                nullable=False,
                server_default="100",
            )
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.drop_column("mutualist_message_limit")
        batch.drop_column("mutualist_interval_seconds")
        batch.drop_column("mutualist_ollama_model")
        batch.drop_column("mutualist_ollama_host")
        batch.drop_column("mutualist_enabled")

"""add human_api_tokens — personal access tokens for humans

Gives humans a first-class non-browser credential, minted from a signed-in
session at ``POST /api/human/tokens``. Only the SHA-256 of the plaintext is
stored (same at-rest scheme as ``agents.api_key_hash``); ``token_hint``
keeps the first few characters for display. A deliberately separate table
from ``agents`` so the human and agent credential planes cannot cross:
``fc_…`` keys resolve only on ``/api/agentic/*``, ``cbp_…`` tokens only on
human routes.

Revision ID: 9f41c07a5d21
Revises: 43932ee1b7e1
Create Date: 2026-08-14 16:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "9f41c07a5d21"
down_revision: str | Sequence[str] | None = "43932ee1b7e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "human_api_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "human_id",
            sa.Integer(),
            sa.ForeignKey("human_users.id"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("token_hint", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=True,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("token_hash", name="uq_human_api_tokens_token_hash"),
    )
    op.create_index(
        "ix_human_api_tokens_human_id", "human_api_tokens", ["human_id"]
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_human_api_tokens_human_id", table_name="human_api_tokens")
    op.drop_table("human_api_tokens")

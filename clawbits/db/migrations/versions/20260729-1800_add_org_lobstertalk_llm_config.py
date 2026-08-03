"""add org lobstertalk LLM config

Per-org cascade mode for the LobsterTalk attention gate: a mode picker
('embedding' keeps today's gate-only behavior; 'cascade' confirms each gate
pass with an LLM triage call) plus the OpenAI-compatible endpoint config.
The api-key column holds a Fernet token, never plaintext.

Revision ID: 28cb7ba3bdc8
Revises: f2c48d1a6b93
Create Date: 2026-07-29 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "28cb7ba3bdc8"
down_revision: str | Sequence[str] | None = "f2c48d1a6b93"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("organizations") as batch:
        batch.add_column(
            sa.Column(
                "attention_mode",
                sa.Text(),
                nullable=False,
                server_default="embedding",
            )
        )
        batch.add_column(sa.Column("attention_llm_base_url", sa.Text(), nullable=True))
        batch.add_column(sa.Column("attention_llm_model", sa.Text(), nullable=True))
        batch.add_column(sa.Column("attention_llm_api_key_encrypted", sa.Text(), nullable=True))
        batch.create_check_constraint(
            "organizations_attention_mode_check",
            "attention_mode IN ('embedding', 'cascade')",
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("organizations") as batch:
        batch.drop_constraint("organizations_attention_mode_check", type_="check")
        batch.drop_column("attention_llm_api_key_encrypted")
        batch.drop_column("attention_llm_model")
        batch.drop_column("attention_llm_base_url")
        batch.drop_column("attention_mode")

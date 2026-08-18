"""add agents.cb_tokens_minted_at — refill cooldown for the PoC mint

The proof-of-cognition handshake tops an agent's CB_TOKENS balance up to a
fixed ceiling. That bounds the *balance* but not cumulative minting: both legs
of the handshake are free and repeatable and the answers ship to clients, so an
agent could spend to zero, re-handshake, and refill without limit — the write
charge metered nothing over any span longer than one drain.

This column records when a top-up last actually moved the balance, so the mint
can enforce a minimum interval between refills. NULL means "never minted",
which is what a brand-new agent needs for its first handshake to succeed.

Revision ID: 5c8ea31f7b40
Revises: 0dbdebfbae3a
Create Date: 2026-08-18 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5c8ea31f7b40"
down_revision: str | Sequence[str] | None = "0dbdebfbae3a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "agents",
        sa.Column("cb_tokens_minted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("agents", "cb_tokens_minted_at")

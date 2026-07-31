"""drop unused transactions and erc20_token_ownership tables

Revision ID: e3a7c02b91d5
Revises: d1f8b3a6c204
Create Date: 2026-07-29 12:00:00.000000

Both tables were carried from the pre-Clawbits codebase and were never wired
into the product:

* ``transactions`` — no ``Transaction(...)`` construction existed anywhere, so
  the table could only ever be empty. Its sole reader,
  ``TableRead.get_transaction_history``, had no callers. It also still carried
  a vestigial ``market_id`` column from the original order-book client.
* ``erc20_token_ownership`` — written only by the ERC-20 simulator that was
  removed alongside ``TableUtils``; its reader
  ``TableRead.get_erc20_asset_ownership`` had no callers either.

Because neither table was ever written, dropping them cannot lose data. The
downgrade recreates the schema (empty) so the revision is reversible.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision: str = "e3a7c02b91d5"
down_revision: str | Sequence[str] | None = "d1f8b3a6c204"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Drop the two never-written tables."""
    op.drop_table("transactions")
    op.drop_table("erc20_token_ownership")


def downgrade() -> None:
    """Recreate both tables (empty — they never held rows)."""
    op.create_table(
        "erc20_token_ownership",
        sa.Column("eth_address", sa.String(), primary_key=True),
        sa.Column(
            "ownership", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
    )
    op.create_table(
        "transactions",
        sa.Column("transaction_id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "timestamp",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.Column("api_key_hash", sa.String(), nullable=False),
        sa.Column("transaction_type", sa.String(), nullable=False),
        sa.Column("market_id", sa.Integer(), nullable=True),
        sa.Column("details", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_transactions_api_key_hash", "transactions", ["api_key_hash"], unique=False
    )

"""add pending key rotation columns to agents

API key rotation is a two-step protocol (``POST /api/agentic/auth/rotate-key``
generates a candidate key, ``…/rotate-key/commit`` swaps it in), but the
pending candidate used to live in a per-process dict on the server instance.
Production runs several uvicorn workers, so the commit request usually landed
on a worker that had never seen the rotate request and failed with
``404 "No pending key rotation found"``.

Persist the pending rotation on the agent row instead, mirroring how
challenge sessions already live in Postgres:

- ``pending_api_key_hash`` — SHA-256 of the candidate key (the plaintext is
  returned once by the rotate call and never stored)
- ``pending_key_expires_at`` — candidate TTL (10 minutes, enforced in the
  commit handler)

``NULL`` means no rotation in flight; a repeat rotate call overwrites any
previous candidate. Both columns are nullable, so every existing row
migrates cleanly.

Revision ID: c7e2a9d4f1b8
Revises: ae6015fc1943
Create Date: 2026-07-28 12:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7e2a9d4f1b8"
down_revision: str | Sequence[str] | None = "ae6015fc1943"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.add_column(sa.Column("pending_api_key_hash", sa.Text(), nullable=True))
        batch.add_column(
            sa.Column("pending_key_expires_at", sa.DateTime(timezone=True), nullable=True)
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.drop_column("pending_key_expires_at")
        batch.drop_column("pending_api_key_hash")

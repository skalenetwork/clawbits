"""add granular privacy flags to human_users

Splits the single ``privacy_mode_enabled`` toggle into four per-signal
flags — one per user-visible signal we now let each user gate
independently. Migrating users who had ``privacy_mode_enabled = TRUE``
preserves intent by flipping all four new flags to FALSE (everything
hidden); fresh installs keep the defaults of TRUE (everything visible).

The legacy ``privacy_mode_enabled`` / ``privacy_last_seen_at`` columns
are kept in the schema for backward compatibility with the old
``POST /api/human/privacy-mode`` endpoint, but the read paths now
consult the four new flags exclusively. Bucketed "Last seen recently"
strings are computed at read time from the always-advancing
``last_seen_at``; no DB-side freeze is needed anymore.

Revision ID: a92c81f6d340
Revises: f4e2a8c91d52
Create Date: 2026-05-28 18:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a92c81f6d340"
down_revision: str | Sequence[str] | None = "f4e2a8c91d52"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("human_users") as batch:
        batch.add_column(
            sa.Column(
                "last_seen_visible",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            )
        )
        batch.add_column(
            sa.Column(
                "online_status_visible",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            )
        )
        batch.add_column(
            sa.Column(
                "read_receipts_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            )
        )
        batch.add_column(
            sa.Column(
                "typing_indicators_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            )
        )

    # Preserve intent for anyone who had the legacy single-toggle flag on:
    # hide everything across the four new signals.
    op.execute(
        "UPDATE human_users SET "
        "last_seen_visible = FALSE, "
        "online_status_visible = FALSE, "
        "read_receipts_enabled = FALSE, "
        "typing_indicators_enabled = FALSE "
        "WHERE privacy_mode_enabled = TRUE"
    )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("human_users") as batch:
        batch.drop_column("typing_indicators_enabled")
        batch.drop_column("read_receipts_enabled")
        batch.drop_column("online_status_visible")
        batch.drop_column("last_seen_visible")

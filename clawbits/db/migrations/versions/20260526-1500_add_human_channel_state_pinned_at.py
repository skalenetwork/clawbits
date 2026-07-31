"""add human_channel_state.pinned_at

Adds per-user-per-channel pin state on top of the existing mute/read row.
NULL means "not pinned"; a timestamp records when the current user pinned
the channel. Mirrors ``muted_at`` exactly — same nullable timestamp shape,
same lazy-row pattern (row created on first interaction). The frontend
exposes this as a separate "Pins" section in the sidebar.

A partial index isn't worth it here: ``human_channel_state`` is keyed on
``human_id`` and already indexed; the "list pins for user" query filters
on ``human_id`` first and then on ``pinned_at IS NOT NULL`` against a row
count that's bounded by channels-per-user (typically tens to low hundreds).

Revision ID: e8a2c4f17b39
Revises: b1a3bf9c8dea
Create Date: 2026-05-26 15:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e8a2c4f17b39"
down_revision: str | Sequence[str] | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("human_channel_state") as batch:
        batch.add_column(
            sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True)
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("human_channel_state") as batch:
        batch.drop_column("pinned_at")

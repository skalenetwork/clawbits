"""add human privacy mode

Revision ID: 9c6d9f0a2b41
Revises: e8a2c4f17b39, b2c3d4e5f6a7
Create Date: 2026-05-26 16:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9c6d9f0a2b41"
down_revision: str | Sequence[str] | None = ("e8a2c4f17b39", "b2c3d4e5f6a7")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("human_users") as batch:
        batch.add_column(
            sa.Column(
                "privacy_mode_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )
        batch.add_column(
            sa.Column("privacy_last_seen_at", sa.DateTime(timezone=True), nullable=True)
        )

    # Defense-in-depth: any row whose ``privacy_mode_enabled`` ever gets
    # flipped to true via direct SQL (admin tools, manual triage) must
    # have a non-NULL ``privacy_last_seen_at`` so the freeze target
    # exists. The default is FALSE so this UPDATE is a no-op for fresh
    # installs; it only matters if a future operation enables privacy
    # without going through ``TableWrite.set_human_privacy_mode``. Done
    # outside the batch_alter_table block so it runs against the newly-
    # widened schema.
    op.execute(
        "UPDATE human_users SET privacy_last_seen_at = COALESCE(last_seen_at, NOW()) "
        "WHERE privacy_mode_enabled = TRUE AND privacy_last_seen_at IS NULL"
    )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("human_users") as batch:
        batch.drop_column("privacy_last_seen_at")
        batch.drop_column("privacy_mode_enabled")

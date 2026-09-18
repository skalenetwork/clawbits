"""allow agent_chat channel type

Revision ID: 8a1c4e9b2d70
Revises: 3f7b0c92ad41
Create Date: 2026-09-18 18:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "8a1c4e9b2d70"
down_revision: str | Sequence[str] | None = "3f7b0c92ad41"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("mm_channels") as batch:
        batch.drop_constraint("mm_channels_type_check", type_="check")
        batch.create_check_constraint(
            "mm_channels_type_check",
            "channel_type IN ('public', 'private', 'direct', 'agent_chat')",
        )


def downgrade() -> None:
    op.execute("DELETE FROM mm_channels WHERE channel_type = 'agent_chat'")
    with op.batch_alter_table("mm_channels") as batch:
        batch.drop_constraint("mm_channels_type_check", type_="check")
        batch.create_check_constraint(
            "mm_channels_type_check",
            "channel_type IN ('public', 'private', 'direct')",
        )

"""index mm_widgets (channel_id, status)

Every widget people see now carries its chat's score: each player's wins and the draws over the
chat's finished games, worked out on read from ``outcome.winner`` and the seats. Until now only the
primary key and the active-only unique index covered ``mm_widgets``, so that read scanned the table.
The index also serves a chat's widget history and the channel-delete cascade. No data changes.

Revision ID: 8059a7adcae2
Revises: 95e07680dba1
Create Date: 2026-10-16 12:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "8059a7adcae2"
down_revision: str | Sequence[str] | None = "95e07680dba1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("ix_mm_widgets_channel_id_status", "mm_widgets", ["channel_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_mm_widgets_channel_id_status", table_name="mm_widgets")

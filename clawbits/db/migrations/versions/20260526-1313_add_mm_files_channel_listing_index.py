"""add ix_mm_files_channel_listing composite index

Speeds up the chat-details "Media / Files" listing
(``GET /api/human/mm/channels/{id}/attachments``) at scale. Without
this index the query plan is:

    bitmap heap scan on ``ix_mm_files_channel_id`` (channel_id alone)
        → filter on status + content_type
        → in-memory sort by ``created_at DESC, file_id DESC``
        → LIMIT

That's O(channel_attachments) in both rows visited and sort work,
which is fine until a single channel holds tens of thousands of
attachments. With the composite index Postgres can do an index seek
on ``(channel_id, status)`` and read in already-sorted order, so
pagination cost is O(limit) instead of O(channel_total).

DESC on the trailing columns matches the listing's ORDER BY exactly
so the planner reads forward through the index — though Postgres can
also use an ASC index with a backward scan, having DESC explicit
removes one optimizer decision and avoids the "wait, did the planner
pick the index?" debugging trip later.

Revision ID: b1a3bf9c8dea
Revises: d695fc82a370
Create Date: 2026-05-26 13:13:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b1a3bf9c8dea"
down_revision: str | Sequence[str] | None = "d695fc82a370"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_index(
        "ix_mm_files_channel_listing",
        "mm_files",
        [
            "channel_id",
            "status",
            sa.text("created_at DESC"),
            sa.text("file_id DESC"),
        ],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_mm_files_channel_listing", table_name="mm_files")

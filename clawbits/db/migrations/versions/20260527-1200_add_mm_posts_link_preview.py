"""add mm_posts.link_preview

Adds a JSONB ``link_preview`` column to ``mm_posts`` so the server can
pre-resolve a single OG-card unfurl when the post is created and embed
the result directly on the row. Frontend renders the card immediately
on first paint with no skeleton swap — eliminating the height shift
that the asynchronous client-side unfurl path produced.

NULL means "no preview embedded" — either the post has no shareable URL,
or it predates this column. The frontend falls back to its client-side
fetcher for the legacy case.

The schema is the dataclass-shape of
``clawbits.link_preview.service.LinkPreview`` (already JSON-serialisable
in the cache layer), plus a small ``cap`` indicator so the client knows
the server intentionally took only the first URL when the message had
several.

Revision ID: c7b1d2e9a013
Revises: e8a2c4f17b39
Create Date: 2026-05-27 12:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "c7b1d2e9a013"
down_revision: str | Sequence[str] | None = "e8a2c4f17b39"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("mm_posts") as batch:
        batch.add_column(
            sa.Column(
                "link_preview",
                JSONB,
                nullable=True,
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("mm_posts") as batch:
        batch.drop_column("link_preview")

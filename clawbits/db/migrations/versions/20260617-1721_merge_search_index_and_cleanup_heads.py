"""merge search index and cleanup heads

Empty merge revision that joins the two migration heads that branched off
``233294252a25``: ``f3a91c7d2e08`` (add full-text search index to mm_posts,
from the search-functionality work) and ``a1c7e9b3f4d2`` (cleanup stale
channels and agents, from the channel-removal work). Both are independent
and apply cleanly in either order; this revision only reunites the tree so
``alembic upgrade head`` has a single target again.

Revision ID: 7b9d1f4a6c20
Revises: f3a91c7d2e08, a1c7e9b3f4d2
Create Date: 2026-06-17 17:21:00.000000

"""
from collections.abc import Sequence

revision: str = "7b9d1f4a6c20"
down_revision: str | Sequence[str] | None = ("f3a91c7d2e08", "a1c7e9b3f4d2")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

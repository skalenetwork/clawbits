"""index the chat-sidebar read path (mm_posts, mm_channel_members)

The chats list was taking seconds to appear because ``mm_posts.channel_id``
was never indexed. It is declared as a bare foreign key, and Postgres does not
create an index for those, so the per-channel subqueries behind the sidebar had
nothing to seek on.

What that cost, measured on 300k posts / 60 channels for one viewer:

    ->  Index Scan using mm_posts_pkey on mm_posts   (actual time=0.022..46.322
                                                      rows=2000 loops=60)
          Index Cond: (post_id > COALESCE(last_read_post_id, 0))
          Filter: channel_id = mm_channels.channel_id AND status = 'published'
          Rows Removed by Filter: 298000
          Buffers: shared hit=543540

The planner used the only index it had — the primary key — satisfied the
``post_id > last_read`` half from it, then filtered ``channel_id`` row by row.
Once per channel. 2.79s of a 2.88s query, and half a million buffer reads for a
result of sixty rows. Adding ``ix_mm_posts_channel_post`` alone took the
endpoint from ~3000ms to ~235ms; with the query rewrite that landed alongside
it (see ``TableRead.get_mm_channels_for_human``) it is ~36ms.

The index is partial on ``status = 'published'`` because no read path wants a
draft or a streaming placeholder, and a streaming post is UPDATEd on every
token — excluding those states keeps the index out of the hottest write loop in
the app.

``mm_channel_members`` gets its participant columns indexed for the same
reason: both existing uniques lead with ``channel_id``, so neither can seek on
a bare ``WHERE human_id = ?`` — the first join of every sidebar load was a scan
of the whole membership table.

DEPLOY NOTE: these are plain (non-CONCURRENT) index builds, matching
``f3a91c7d2e08`` which created the two GIN indexes on this same table. Alembic
runs migrations inside a transaction, and CONCURRENTLY cannot. The build takes
an ACCESS EXCLUSIVE lock on ``mm_posts`` for its duration — seconds at current
volume. If ``mm_posts`` has grown past a few million rows by the time this
runs, build it by hand out-of-band first and let the migration no-op:

    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_mm_posts_channel_post
        ON mm_posts (channel_id, post_id) WHERE status = 'published';

Revision ID: c4e1b9a7f2d5
Revises: a7d3f81c62b9
Create Date: 2026-08-14 11:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4e1b9a7f2d5"
down_revision: str | Sequence[str] | None = "a7d3f81c62b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_index(
        "ix_mm_posts_channel_post",
        "mm_posts",
        ["channel_id", "post_id"],
        postgresql_where=sa.text("status = 'published'"),
        if_not_exists=True,
    )
    op.create_index(
        "ix_mm_channel_members_human_id",
        "mm_channel_members",
        ["human_id"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_mm_channel_members_agent_id",
        "mm_channel_members",
        ["agent_id"],
        if_not_exists=True,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_mm_channel_members_agent_id", table_name="mm_channel_members")
    op.drop_index("ix_mm_channel_members_human_id", table_name="mm_channel_members")
    op.drop_index("ix_mm_posts_channel_post", table_name="mm_posts")

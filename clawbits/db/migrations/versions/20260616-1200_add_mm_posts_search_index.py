"""add full-text search index to mm_posts

Server-side message-content search (see ``docs/protocol/SEARCH_SPEC.md``).
Adds, on ``mm_posts``:

* ``CREATE EXTENSION pg_trgm`` — trigram operator class for the
  typo-tolerant ``similarity()`` fallback (and ILIKE acceleration). It
  ships with stock Postgres (``contrib``) and is enabled on the managed
  providers we target. ``IF NOT EXISTS`` keeps the migration idempotent.

* ``message_tsv`` — a STORED GENERATED ``tsvector`` derived from
  ``message``. A generated column stays in sync automatically on every
  insert/edit, so search needs no trigger, no CDC pipeline, and no worker
  (the backend has no job queue). The two-argument
  ``to_tsvector('english', message)`` form is IMMUTABLE, which a generated
  column requires; the one-argument form is not and Postgres would reject
  it here.

* ``ix_mm_posts_message_tsv`` — the GIN full-text index proper.

* ``ix_mm_posts_message_trgm`` — a GIN trigram index on the raw
  ``message`` powering the misspelling fallback when a ``tsquery`` match
  returns nothing.

Encrypted-channel content never reaches ``mm_posts`` (it lives in
``mls_encrypted_posts`` per the encrypted-channels spec), so this index is
structurally confined to server-readable plaintext — there is no path by
which ciphertext could enter the search index.

Revision ID: f3a91c7d2e08
Revises: 233294252a25
Create Date: 2026-06-16 12:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import TSVECTOR

revision: str = "f3a91c7d2e08"
down_revision: str | Sequence[str] | None = "233294252a25"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.add_column(
        "mm_posts",
        sa.Column(
            "message_tsv",
            TSVECTOR(),
            sa.Computed("to_tsvector('english', message)", persisted=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_mm_posts_message_tsv",
        "mm_posts",
        ["message_tsv"],
        postgresql_using="gin",
    )
    op.create_index(
        "ix_mm_posts_message_trgm",
        "mm_posts",
        ["message"],
        postgresql_using="gin",
        postgresql_ops={"message": "gin_trgm_ops"},
    )


def downgrade() -> None:
    op.drop_index("ix_mm_posts_message_trgm", table_name="mm_posts")
    op.drop_index("ix_mm_posts_message_tsv", table_name="mm_posts")
    op.drop_column("mm_posts", "message_tsv")
    # pg_trgm is intentionally left installed on downgrade — dropping a
    # shared extension is riskier than the harmless cost of leaving it.

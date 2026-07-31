"""add trace_id to mm_posts for end-to-end latency tracing

Adds a nullable ``trace_id`` to ``mm_posts``. The id (``tr_<uuid>``) is minted
by the originating client on a human send and threaded through every hop of a
message round-trip — human POST → server → agent pickup (agentic GET) → agent
reply POST → SSE fan-out — so the cross-subsystem latency tracer can stitch
spans from the frontend, server, plugin, and OpenClaw into one waterfall keyed
on a single id.

Unlike ``client_msg_uuid`` (which lives only on the in-flight response/SSE and
is never stored), ``trace_id`` is persisted: the agent reads it back off the
inbound post through a *separate* agentic GET, then stamps the same id on its
reply. Nullable so every existing row — and any post created without tracing —
migrates cleanly.

Revision ID: f9b3c7e21a05
Revises: e7c1a9f34b08
Create Date: 2026-06-03 09:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f9b3c7e21a05"
down_revision: str | Sequence[str] | None = "e7c1a9f34b08"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _has_column(table: str, column: str) -> bool:
    """True if *column* already exists on *table* in the live DB."""
    inspector = sa.inspect(op.get_bind())
    return any(col["name"] == column for col in inspector.get_columns(table))


def upgrade() -> None:
    """Upgrade schema.

    Idempotent: skip the ``ADD COLUMN`` when ``trace_id`` is already present.
    This happens when the schema was created directly from the SQLModel models
    (``MmPost`` already declares ``trace_id``) rather than purely via migrations
    — without this guard Postgres raises ``DuplicateColumn``.
    """
    if _has_column("mm_posts", "trace_id"):
        return
    with op.batch_alter_table("mm_posts") as batch:
        batch.add_column(sa.Column("trace_id", sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema. No-op if the column is already gone."""
    if not _has_column("mm_posts", "trace_id"):
        return
    with op.batch_alter_table("mm_posts") as batch:
        batch.drop_column("trace_id")

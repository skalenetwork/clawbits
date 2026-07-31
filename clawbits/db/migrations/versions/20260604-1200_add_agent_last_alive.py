"""add last_alive_at to agents (agent liveness)

Introduces ``agents.last_alive_at`` — the last time an agent's plugin pinged
``POST /api/agentic/alive``. It drives the agent's global online status in the
UI (the analogue of a human's presence dot):

- ``NULL``      — the agent has never pinged; it's still in "setup"
- within 40 min — "available"
- older         — "offline"

(see ``clawbits.datastructures.mm_models.agent_liveness_status``).

Existing agents are backfilled to their ``creation_time`` so they read
"offline" (i.e. past setup) rather than being stuck in "setup" forever until
their plugin is upgraded to ping. Rows with no ``creation_time`` (very old
legacy) fall back to the epoch, which also reads "offline". Brand-new agents
created after this migration start ``NULL`` = "setup" until their first ping.

Nullable, so every existing row migrates cleanly.

Revision ID: d4f9a1c3e207
Revises: f9b3c7e21a05
Create Date: 2026-06-04 12:00:00.000000
"""
from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision: str = "d4f9a1c3e207"
down_revision: str | Sequence[str] | None = "f9b3c7e21a05"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.add_column(
            sa.Column("last_alive_at", sa.DateTime(timezone=True), nullable=True)
        )
    # Backfill existing agents to creation_time (epoch for the rare row with no
    # creation_time) so they read "offline", not "setup". COALESCE is standard
    # SQL and the timestamp is a bound param, so this is portable across
    # Postgres (prod) and SQLite (tests that run migrations).
    op.execute(
        sa.text(
            "UPDATE agents SET last_alive_at = COALESCE(creation_time, :epoch) "
            "WHERE last_alive_at IS NULL"
        ).bindparams(epoch=datetime(1970, 1, 1, tzinfo=UTC))
    )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("agents") as batch:
        batch.drop_column("last_alive_at")

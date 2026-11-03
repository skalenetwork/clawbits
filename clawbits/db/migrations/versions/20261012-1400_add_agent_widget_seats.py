"""add agents.widgets_enabled, agents.capabilities and mm_widgets.acted_revs

Agents take widget seats from here on. ``widgets_enabled`` is the operator's "Can play games"
consent, off for every agent until someone turns it on. ``capabilities`` is what the runtime
reports on its liveness ping; empty until the next ping restates it. ``acted_revs`` maps each seat
to the rev it last acted at or was handed the move, so a person's action on a slightly stale board
can still be taken; existing widgets start without it, which keeps today's strict rev check.

Revision ID: 95e07680dba1
Revises: 994dc55c8ee3
Create Date: 2026-10-12 14:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

revision: str = "95e07680dba1"
down_revision: str | Sequence[str] | None = "994dc55c8ee3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agents",
        sa.Column("widgets_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "agents",
        sa.Column("capabilities", ARRAY(sa.Text()), nullable=False, server_default="{}"),
    )
    op.add_column(
        "mm_widgets",
        sa.Column("acted_revs", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
    )


def downgrade() -> None:
    op.drop_column("mm_widgets", "acted_revs")
    op.drop_column("agents", "capabilities")
    op.drop_column("agents", "widgets_enabled")

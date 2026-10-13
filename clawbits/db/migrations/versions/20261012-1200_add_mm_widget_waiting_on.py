"""add mm_widgets.waiting_on and index mm_widget_seats.agent_id

``waiting_on`` is every seat a widget waits on, where ``turn`` names at most one: both fleets in
battleship setup, both bets in a blackjack round. "Your move" now reads it, so each player of a
game both may act in sees it. It is empty once a widget ends.

Active widgets are backfilled in Python by their kind's own ``waiting_on``, the rule the server
writes with from now on; a kind the code no longer knows keeps the empty default. Ended widgets
need nothing. The ``agent_id`` index is for agents' seats, looked up the way people's are.

Revision ID: 994dc55c8ee3
Revises: 59a1f4320c15
Create Date: 2026-10-12 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

revision: str = "994dc55c8ee3"
down_revision: str | Sequence[str] | None = "59a1f4320c15"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_widgets = sa.table(
    "mm_widgets",
    sa.column("widget_id", sa.String()),
    sa.column("kind", sa.String()),
    sa.column("status", sa.String()),
    sa.column("state", JSONB),
    sa.column("waiting_on", ARRAY(sa.Text())),
)


def upgrade() -> None:
    op.add_column(
        "mm_widgets",
        sa.Column("waiting_on", ARRAY(sa.Text()), nullable=False, server_default="{}"),
    )
    bind = op.get_bind()
    active = bind.execute(
        sa.select(_widgets.c.widget_id, _widgets.c.kind, _widgets.c.state).where(
            _widgets.c.status == "active"
        )
    ).all()
    if active:
        # Imported only when there is something to fill: a fresh database never loads app code here,
        # so a later move of the kinds can't break building one from the migrations.
        from clawbits.widgets import KINDS
    for widget_id, kind_name, state in active:
        kind = KINDS.get(kind_name)
        if kind is None:
            continue
        bind.execute(
            _widgets.update()
            .where(_widgets.c.widget_id == widget_id)
            .values(waiting_on=list(kind.waiting_on(state)))
        )
    op.create_index("ix_mm_widget_seats_agent_id", "mm_widget_seats", ["agent_id"])


def downgrade() -> None:
    op.drop_index("ix_mm_widget_seats_agent_id", table_name="mm_widget_seats")
    op.drop_column("mm_widgets", "waiting_on")

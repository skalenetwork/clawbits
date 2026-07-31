"""add automation run-now generations

Adds the run-now signal to ``automations``: an imperative "run this job once,
now" request that is separate from the desired-state generation. The operator
bumps ``run_requested_generation``; the plugin runs the gateway job
(``cron.run`` force) when it exceeds ``run_observed_generation``, then reports
the observed value back. Monotonic, so rapid repeat clicks collapse to a single
pending run. See
``docs/protocol/OPENCLAW_AUTOMATIONS_INTEGRATION_STRATEGY.md``.

Revision ID: c7e2b9a4f1d3
Revises: b9e4c1a7f2d8
Create Date: 2026-06-30 15:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7e2b9a4f1d3"
down_revision: str | Sequence[str] | None = "b9e4c1a7f2d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "automations",
        sa.Column(
            "run_requested_generation",
            sa.BigInteger(),
            server_default="0",
            nullable=False,
        ),
    )
    op.add_column(
        "automations",
        sa.Column(
            "run_observed_generation",
            sa.BigInteger(),
            server_default="0",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("automations", "run_observed_generation")
    op.drop_column("automations", "run_requested_generation")

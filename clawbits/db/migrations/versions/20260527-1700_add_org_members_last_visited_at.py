"""add org_members.last_visited_at

Adds a per-membership timestamp tracking the last time the user actively
switched into / opened this org in the UI. NULL means "never visited" —
the org switcher uses that to render a "New" pill so a user can tell at
a glance that they were just added to an org they haven't entered yet.

Bumped whenever the user activates the org via the dedicated visit
endpoint (or on first load of org-scoped channel data). Independent of
``joined_at`` because the moment of joining and the moment of first
entering are different — a freshly-invited user has ``joined_at`` set
but ``last_visited_at == NULL`` until they click in.

Backfill: every membership in place at migration time gets
``last_visited_at = joined_at`` — those users have been around, and we
don't want the "New" pill firing for every org they've quietly been
sitting in for months. Only memberships created *after* this migration
start with NULL and can legitimately advertise as new.

Revision ID: d8e3f7a2b419
Revises: 9c6d9f0a2b41, c7b1d2e9a013
Create Date: 2026-05-27 17:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d8e3f7a2b419"
# Doubles as a mergepoint: joins the privacy-mode / agent-operator head
# (``9c6d9f0a2b41``) with the link-preview head (``c7b1d2e9a013``) that
# this branch was already sitting on, so alembic sees a single head.
down_revision: str | Sequence[str] | None = ("9c6d9f0a2b41", "c7b1d2e9a013")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("org_members") as batch:
        batch.add_column(
            sa.Column("last_visited_at", sa.DateTime(timezone=True), nullable=True)
        )
    op.execute(
        "UPDATE org_members SET last_visited_at = joined_at "
        "WHERE last_visited_at IS NULL"
    )


def downgrade() -> None:
    with op.batch_alter_table("org_members") as batch:
        batch.drop_column("last_visited_at")

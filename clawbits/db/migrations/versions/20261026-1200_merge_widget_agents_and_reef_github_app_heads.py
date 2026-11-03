"""merge widget agents and reef GitHub App heads

Revision ID: c3404d368e23
Revises: 8059a7adcae2, 7c3e9a1b5d20
Create Date: 2026-10-26 12:00:00.000000

Joins the two heads created by bringing the widget agents work onto a newer ``main``. Both branched off
``59a1f4320c15``:

* ``7c3e9a1b5d20`` - each org's own reef GitHub App (main).
* ``8059a7adcae2`` - agent seats, ``waiting_on`` and the score index on ``mm_widgets`` (this branch).

They touch disjoint tables. A no-op merge rather than repointing, so a database at either head reaches the single
head by running only the branch it is missing.
"""

from collections.abc import Sequence

revision: str = "c3404d368e23"
down_revision: str | Sequence[str] | None = ("8059a7adcae2", "7c3e9a1b5d20")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

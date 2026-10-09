"""merge widgets and skill content heads

Revision ID: 59a1f4320c15
Revises: 35abc330f942, 3cb9892ce879
Create Date: 2026-10-09 12:00:00.000000

Joins the two heads created by bringing the widgets work onto a newer ``main``. Both branched off ``fe1d6327aa11``:

* ``3cb9892ce879`` - skill content and takeover (main).
* ``35abc330f942`` - ``mm_widgets`` and the widget switches (this branch).

They touch disjoint tables. A no-op merge rather than repointing, so a database at either head reaches the single
head by running only the branch it is missing.
"""

from collections.abc import Sequence

revision: str = "59a1f4320c15"
down_revision: str | Sequence[str] | None = ("35abc330f942", "3cb9892ce879")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

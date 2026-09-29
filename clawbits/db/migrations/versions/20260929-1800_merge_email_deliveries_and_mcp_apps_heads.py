"""merge email deliveries and mcp app heads

Revision ID: b4eb14393b0e
Revises: e7322b2aed49, 3e9c2b7d5a14
Create Date: 2026-09-29 18:00:00.000000

Joins the two heads created by merging ``main`` into mcp-integration. Both branched off ``8a1c4e9b2d70``:

* ``e7322b2aed49`` - ``email_deliveries`` (main).
* ``3e9c2b7d5a14`` - ``mm_posts.steps`` then ``mcp_app_resources`` (this branch).

They touch disjoint tables. A no-op merge rather than repointing, so a database at either head reaches the single
head by running only the branch it is missing.
"""

from collections.abc import Sequence

revision: str = "b4eb14393b0e"
down_revision: str | Sequence[str] | None = ("e7322b2aed49", "3e9c2b7d5a14")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

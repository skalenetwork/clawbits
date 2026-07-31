"""merge mutualist settings and agent_type heads

Revision ID: f0e1d2c3b4a5
Revises: 8f3a5c1d9e42, d3b1f7a2c6e4
Create Date: 2026-07-08 18:50:00.000000

Joins the two migration heads that resulted from merging main (which added
``agents.agent_type`` / ``agents.plugin_version`` in ``d3b1f7a2c6e4``) into the
mutualist branch (``8f3a5c1d9e42``). Both branched off ``c7e2b9a4f1d3``; this
no-op merge lets any database at either head — or mid-way — upgrade cleanly to a
single head, running whichever branch migration it is missing.
"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "f0e1d2c3b4a5"
down_revision: str | Sequence[str] | None = ("8f3a5c1d9e42", "d3b1f7a2c6e4")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass

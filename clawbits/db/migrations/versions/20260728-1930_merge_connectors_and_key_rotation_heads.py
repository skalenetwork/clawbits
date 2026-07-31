"""merge human_connectors and pending_key_rotation heads

Revision ID: d1f8b3a6c204
Revises: b8e4a1c7d902, c7e2a9d4f1b8
Create Date: 2026-07-28 19:30:00.000000

Joins the two migration heads that resulted from merging PR #245
(``human_connectors``, ``b8e4a1c7d902``) and PR #246
(``agents.pending_key_rotation``, ``c7e2a9d4f1b8``) into main. Both branched
off ``ae6015fc1943``; this no-op merge lets any database at either head — or
mid-way — upgrade cleanly to a single head, running whichever branch migration
it is missing. The two branches touch unrelated tables, so apply order is
immaterial.
"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "d1f8b3a6c204"
down_revision: str | Sequence[str] | None = ("b8e4a1c7d902", "c7e2a9d4f1b8")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass

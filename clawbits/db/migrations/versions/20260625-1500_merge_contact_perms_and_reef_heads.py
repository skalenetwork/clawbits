"""merge contact-permission and reef-sandbox heads

Empty merge revision joining the two migration heads that branched off
``7b9d1f4a6c20``: ``d4e8b1c509a7`` (the contact-permission chain — add
``agent_contact_permissions`` and drop ``require_response_approval``) and
``c4e7a1b9d3f2`` (add ``reef_sandbox_id``). The two branches are independent
and apply cleanly in either order; this revision only reunites the tree so
``alembic upgrade head`` has a single target again.

Revision ID: f6d2a9c4b71e
Revises: d4e8b1c509a7, c4e7a1b9d3f2
Create Date: 2026-06-25 15:00:00.000000

"""
from collections.abc import Sequence

revision: str = "f6d2a9c4b71e"
down_revision: str | Sequence[str] | None = ("d4e8b1c509a7", "c4e7a1b9d3f2")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

"""merge skills chain and human api tokens

Revision ID: 0dbdebfbae3a
Revises: c4e1b9a7f2d5, 9f41c07a5d21
Create Date: 2026-08-17 12:35:10.170774

Joins the two heads created by merging ``main`` into the skills/env branch. Both
branched off ``43932ee1b7e1``:

* ``c4e1b9a7f2d5`` — the skills-library chain (``f2c9a4d7b103`` skills catalog →
  ``a7d3f81c62b9`` per-agent installs → ``c4e1b9a7f2d5`` chat-sidebar indexes).
* ``9f41c07a5d21`` — ``human_api_tokens`` (main).

They touch disjoint tables, so apply order is immaterial.

A no-op merge rather than repointing the skills chain onto ``9f41c07a5d21``:
databases already carrying the skills chain are stamped at ``c4e1b9a7f2d5``, and
linearizing would leave them at what alembic considers head with
``human_api_tokens`` never created. The merge lets a database at *either* head
reach a single head, running whichever branch migration it is missing.

Without it ``alembic upgrade head`` aborts on an ambiguous head, and because
that command is the first link of the container CMD, the container would exit
non-zero and crash-loop under ``restart: unless-stopped``.
"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "0dbdebfbae3a"
down_revision: str | Sequence[str] | None = ("c4e1b9a7f2d5", "9f41c07a5d21")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass

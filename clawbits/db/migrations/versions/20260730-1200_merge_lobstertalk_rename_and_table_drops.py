"""merge lobstertalk rename and unused-table drops

Revision ID: f2c48d1a6b93
Revises: e3a7c02b91d5, e5b7c2a91f04
Create Date: 2026-07-30 12:00:00.000000

Joins the two heads created by merging the pre-open-source cleanup branch into
``main``. Both branched off ``d1f8b3a6c204``:

* ``e3a7c02b91d5`` — drops the never-written ``transactions`` and
  ``erc20_token_ownership`` tables (cleanup branch).
* ``e5b7c2a91f04`` — renames the ``agents.mutualist_*`` columns to
  ``lobstertalk_*`` (main).

They touch disjoint tables, so apply order is immaterial. This no-op merge lets
a database at either head — or at ``d1f8b3a6c204``, which is where production
sits — reach a single head, running whichever branch migration it is missing.

Without it ``alembic upgrade head`` aborts on an ambiguous head, and because
that command is the first link of the container CMD, the container would exit
non-zero and crash-loop under ``restart: unless-stopped``.
"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "f2c48d1a6b93"
down_revision: str | Sequence[str] | None = ("e3a7c02b91d5", "e5b7c2a91f04")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass

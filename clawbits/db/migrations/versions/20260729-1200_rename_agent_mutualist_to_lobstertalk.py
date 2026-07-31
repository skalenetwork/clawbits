"""rename agent mutualist_* columns to lobstertalk_*

The feature was renamed to LobsterTalk (the protocol name already used by the
Manage-page tile and its "Powered by the LobsterTalk protocol" tooltip). The
five agent columns added in ``8f3a5c1d9e42`` carry the old name; rename them in
place so no data moves. ``8f3a5c1d9e42`` is left untouched — it is the frozen
record of what the schema was, so a fresh database still creates the
``mutualist_*`` columns and arrives here to be renamed.

Revision ID: e5b7c2a91f04
Revises: d1f8b3a6c204
Create Date: 2026-07-29 12:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "e5b7c2a91f04"
down_revision: str | Sequence[str] | None = "d1f8b3a6c204"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = (
    "enabled",
    "ollama_host",
    "ollama_model",
    "interval_seconds",
    "message_limit",
)


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("agents") as batch:
        for suffix in _COLUMNS:
            batch.alter_column(f"mutualist_{suffix}", new_column_name=f"lobstertalk_{suffix}")


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("agents") as batch:
        for suffix in _COLUMNS:
            batch.alter_column(f"lobstertalk_{suffix}", new_column_name=f"mutualist_{suffix}")

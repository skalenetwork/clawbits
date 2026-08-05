"""allow llm_only attention mode

Third value for organizations.attention_mode: 'llm_only' skips the embedding
gate entirely and sends every post to the org's LLM triage endpoint, which
becomes the sole filter (and fails closed — no gate verdict to fall back on).
Data-free: only the CHECK constraint widens.

Revision ID: 4b9f1d27c3e6
Revises: 28cb7ba3bdc8
Create Date: 2026-08-03 15:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "4b9f1d27c3e6"
down_revision: str | Sequence[str] | None = "28cb7ba3bdc8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("organizations") as batch:
        batch.drop_constraint("organizations_attention_mode_check", type_="check")
        batch.create_check_constraint(
            "organizations_attention_mode_check",
            "attention_mode IN ('embedding', 'cascade', 'llm_only')",
        )


def downgrade() -> None:
    """Downgrade schema."""
    # llm_only rows must land on a still-valid value before the constraint
    # re-tightens. 'cascade' is the nearest behavior: same LLM config, the
    # embedding gate simply runs in front of it again.
    op.execute(
        "UPDATE organizations SET attention_mode = 'cascade' "
        "WHERE attention_mode = 'llm_only'"
    )
    with op.batch_alter_table("organizations") as batch:
        batch.drop_constraint("organizations_attention_mode_check", type_="check")
        batch.create_check_constraint(
            "organizations_attention_mode_check",
            "attention_mode IN ('embedding', 'cascade')",
        )

"""add 'all' attention mode

Fourth value for organizations.attention_mode: 'all' skips triage entirely —
no embedding gate, no LLM confirm. Every channel post (past the native gates
and the per-(agent, channel) cooldown) is delivered as a nudge, and the
agent's own model decides whether to reply under the reply-only-if-useful
attention framing. Data-free: only the CHECK constraint widens.

Revision ID: 9c2e5f81d4b7
Revises: 4b9f1d27c3e6
Create Date: 2026-08-04 14:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "9c2e5f81d4b7"
down_revision: str | Sequence[str] | None = "4b9f1d27c3e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("organizations") as batch:
        batch.drop_constraint("organizations_attention_mode_check", type_="check")
        batch.create_check_constraint(
            "organizations_attention_mode_check",
            "attention_mode IN ('embedding', 'cascade', 'llm_only', 'all')",
        )


def downgrade() -> None:
    """Downgrade schema."""
    # 'all' rows must land on a still-valid value before the constraint
    # re-tightens. 'embedding' is the safe landing: it works with no LLM
    # config at all (an 'all' org may have none), whereas llm_only would
    # fail closed into silence on an empty endpoint.
    op.execute(
        "UPDATE organizations SET attention_mode = 'embedding' "
        "WHERE attention_mode = 'all'"
    )
    with op.batch_alter_table("organizations") as batch:
        batch.drop_constraint("organizations_attention_mode_check", type_="check")
        batch.create_check_constraint(
            "organizations_attention_mode_check",
            "attention_mode IN ('embedding', 'cascade', 'llm_only')",
        )

"""raise the per-org attention cooldown floor from 5s to 30s

The org-settable override (organizations.attention_cooldown_seconds) was
bounded 5..3600. Five seconds is short enough that a busy channel becomes a
turn-per-message firehose for every opted-in agent — and in the LLM modes, a
triage call per message per agent against a metered endpoint. 30s is the new
floor; the ceiling is unchanged.

Existing rows between 5 and 29 are clamped UP to 30 before the constraint
tightens. Without that the ALTER would fail on any deployment where an owner
had picked a lower value, and clamping is the safe direction (a longer window
throttles more, never less).

Revision ID: c3f8b17d29a4
Revises: b7d4a92c1e83
Create Date: 2026-08-04 19:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "c3f8b17d29a4"
down_revision: str | Sequence[str] | None = "b7d4a92c1e83"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # Data first, constraint second — the reverse order fails the ALTER.
    op.execute(
        "UPDATE organizations SET attention_cooldown_seconds = 30 "
        "WHERE attention_cooldown_seconds IS NOT NULL "
        "AND attention_cooldown_seconds < 30"
    )
    with op.batch_alter_table("organizations") as batch:
        batch.drop_constraint("organizations_attention_cooldown_check", type_="check")
        batch.create_check_constraint(
            "organizations_attention_cooldown_check",
            "attention_cooldown_seconds IS NULL "
            "OR attention_cooldown_seconds BETWEEN 30 AND 3600",
        )


def downgrade() -> None:
    """Downgrade schema.

    Restores the wider 5..3600 bound. The clamped values are not restored —
    the originals aren't recorded anywhere, and a row sitting at 30 is valid
    under the old constraint, so re-widening alone is enough to make the
    schema accept them again.
    """
    with op.batch_alter_table("organizations") as batch:
        batch.drop_constraint("organizations_attention_cooldown_check", type_="check")
        batch.create_check_constraint(
            "organizations_attention_cooldown_check",
            "attention_cooldown_seconds IS NULL "
            "OR attention_cooldown_seconds BETWEEN 5 AND 3600",
        )

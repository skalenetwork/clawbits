"""meter CB_TOKENS minting per rolling window, and clamp inflated balances

The proof-of-cognition handshake mints tokens and is free on both legs — the
challenge is a ``GET`` (the billing middleware only charges writes) and
``challenge_response`` is explicitly billing-exempt — and the answers ship to
clients in ``clawbits/datastructures/known_answers.py``. Capping the *balance*
at a ceiling therefore bounds what an agent can hold but not what it can spend:
it can alternate write -> handshake -> refill indefinitely.

These two columns meter the mint itself. At most one ceiling's worth may be
added per rolling window (24h by default, see
``ClawBitsServer.CB_TOKENS_MINT_WINDOW_SECONDS``), tracked in the same locked
transaction as the balance update. Well-behaved clients never approach it —
they mint once at signup and would have to burn the entire balance to notice.

The data fix-up clamps any balance already above the ceiling. Such a balance is
only reachable through the earlier additive mint (``cb_tokens += amount`` with
no cap), so an agent holding one accumulated it by replaying the handshake;
leaving it in place would let that agent keep spending past the new bound.

Revision ID: e7b3c1d95a48
Revises: 0dbdebfbae3a
Create Date: 2026-08-19 15:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7b3c1d95a48"
down_revision: str | Sequence[str] | None = "0dbdebfbae3a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Must match ClawBitsServer.CB_TOKENS_BALANCE_CEILING. Inlined rather than
# imported: a migration has to keep describing the schema as it was at this
# revision even after the constant moves or changes.
CB_TOKENS_BALANCE_CEILING = 10_000_000_000


def upgrade() -> None:
    op.add_column(
        "agents",
        sa.Column("cb_tokens_minted_window_start", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "agents",
        sa.Column(
            "cb_tokens_minted_in_window",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
    )

    # Remediation for the additive-mint era. Deliberately not reversible: the
    # pre-clamp value isn't recorded anywhere, and restoring it would restore
    # the over-grant along with it.
    op.execute(
        sa.text(
            "UPDATE agents SET cb_tokens = :ceiling WHERE cb_tokens > :ceiling"
        ).bindparams(ceiling=CB_TOKENS_BALANCE_CEILING)
    )


def downgrade() -> None:
    # Only the columns come back. Balances clamped on the way up stay clamped —
    # see the note in upgrade().
    op.drop_column("agents", "cb_tokens_minted_in_window")
    op.drop_column("agents", "cb_tokens_minted_window_start")

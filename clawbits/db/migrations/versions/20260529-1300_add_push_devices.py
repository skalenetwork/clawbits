"""create push_devices

Adds the ``push_devices`` table — the device/subscription registry behind
push notifications. Web push (the first transport wired up) stores a
browser's Push API subscription: ``token`` is the endpoint URL and
``p256dh``/``auth`` are its encryption keys. The schema is transport-tagged
(``webpush`` | ``apns`` | ``fcm``) so the native mobile apps can reuse the
same table later — those set ``token`` to the native device token and leave
the web-push key columns NULL.

``token`` is unique so re-subscribing the same browser upserts its row
rather than piling up duplicates; the dispatcher prunes a row the moment
its push service reports the subscription gone (HTTP 404/410), so the table
only ever holds endpoints we believe are deliverable.

Revision ID: e7c1a9f34b08
Revises: b7d3f2a90c14
Create Date: 2026-05-29 13:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7c1a9f34b08"
down_revision: str | Sequence[str] | None = "b7d3f2a90c14"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "push_devices",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("human_id", sa.Integer(), nullable=False),
        sa.Column(
            "transport",
            sa.Text(),
            server_default="webpush",
            nullable=False,
        ),
        sa.Column("token", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.Text(), nullable=True),
        sa.Column("auth", sa.Text(), nullable=True),
        sa.Column("app", sa.Text(), server_default="web", nullable=False),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column(
            "enabled",
            sa.Boolean(),
            server_default="true",
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "transport IN ('webpush', 'apns', 'fcm')",
            name="push_devices_transport_check",
        ),
        sa.ForeignKeyConstraint(
            ["human_id"], ["human_users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token", name="uq_push_devices_token"),
    )
    op.create_index(
        "ix_push_devices_human",
        "push_devices",
        ["human_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_push_devices_human",
        table_name="push_devices",
    )
    op.drop_table("push_devices")

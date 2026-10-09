"""add mm_widgets, mm_widget_seats and the widgets switches

Chat widgets (a chess game first): ``mm_widgets`` holds each widget's kind, state and revision,
``mm_widget_seats`` who plays which seat, and ``mm_posts.widget_id`` the post that shows it. The
org and chat ``widgets_enabled`` switches both start off, so nothing changes until an owner and a
chat opt in.

The ``mm_posts`` foreign key is added ``NOT VALID``: every existing row is NULL, so validating it
would only scan the busiest table under lock to prove that. New rows are checked as usual.

Revision ID: 35abc330f942
Revises: fe1d6327aa11
Create Date: 2026-10-07 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "35abc330f942"
down_revision: str | Sequence[str] | None = "fe1d6327aa11"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mm_widgets",
        sa.Column("widget_id", sa.String(), nullable=False),
        sa.Column("channel_id", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("turn", sa.String(), nullable=True),
        sa.Column("rev", sa.Integer(), nullable=False),
        sa.Column("state", JSONB, nullable=False),
        sa.Column("outcome", JSONB, nullable=True),
        sa.Column("created_by_human_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("status IN ('active', 'finished', 'aborted')", name="mm_widgets_status_check"),
        sa.ForeignKeyConstraint(["channel_id"], ["mm_channels.channel_id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_human_id"], ["human_users.id"]),
        sa.PrimaryKeyConstraint("widget_id"),
    )
    op.create_index(
        "uq_mm_widgets_channel_active",
        "mm_widgets",
        ["channel_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_table(
        "mm_widget_seats",
        sa.Column("widget_id", sa.String(), nullable=False),
        sa.Column("seat", sa.String(), nullable=False),
        sa.Column("human_id", sa.Integer(), nullable=True),
        sa.Column("agent_id", sa.String(), nullable=True),
        sa.CheckConstraint(
            "(human_id IS NULL) <> (agent_id IS NULL)", name="mm_widget_seats_participant_check"
        ),
        sa.ForeignKeyConstraint(["widget_id"], ["mm_widgets.widget_id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["human_id"], ["human_users.id"]),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.agent_id"]),
        sa.PrimaryKeyConstraint("widget_id", "seat"),
    )
    op.create_index("ix_mm_widget_seats_human_id", "mm_widget_seats", ["human_id"])
    op.add_column("mm_posts", sa.Column("widget_id", sa.String(), nullable=True))
    op.create_foreign_key(
        "mm_posts_widget_id_fkey",
        "mm_posts",
        "mm_widgets",
        ["widget_id"],
        ["widget_id"],
        ondelete="SET NULL",
        postgresql_not_valid=True,
    )
    op.create_index(
        "ix_mm_posts_widget_id",
        "mm_posts",
        ["widget_id"],
        postgresql_where=sa.text("widget_id IS NOT NULL"),
    )
    op.add_column(
        "organizations",
        sa.Column("widgets_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "mm_channels",
        sa.Column("widgets_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("mm_channels", "widgets_enabled")
    op.drop_column("organizations", "widgets_enabled")
    op.drop_index("ix_mm_posts_widget_id", table_name="mm_posts")
    op.drop_constraint("mm_posts_widget_id_fkey", "mm_posts", type_="foreignkey")
    op.drop_column("mm_posts", "widget_id")
    op.drop_index("ix_mm_widget_seats_human_id", table_name="mm_widget_seats")
    op.drop_table("mm_widget_seats")
    op.drop_index("uq_mm_widgets_channel_active", table_name="mm_widgets")
    op.drop_table("mm_widgets")

"""create skills + skill_versions (the org skills catalog)

Adds the catalog half of the skills library: an org authors versioned skills
that can later be installed onto its agents. This migration is deliberately
catalog-only — there is no agent, plugin, or sync involvement yet, so it can
ship and be used (author / version / fork / render) before any client exists.
See ``docs/protocol/SKILLS_LIBRARY_PLAN.md`` §8 (M1).

``skills`` — the mutable pointer: identity, visibility, fork lineage, and which
version is current. ``org_id`` is NOT NULL and is *the* tenancy boundary; a
skill has no agent to join through, unlike ``automations`` whose ``org_id`` is
nullable and never actually filtered on. ``slug`` is the on-disk directory name
AND the frontmatter ``name`` OpenClaw requires them to match, hence the unique
``(org_id, slug)``.

``skill_versions`` — immutable content. There is no update path: editing
publishes a new row, which is what makes rollback a dropdown and what lets
``content_hash`` be a safe drift gate for the eventual reconciler. Content is
folded into JSONB (manifest + body + <=9 markdown reference files, 256 KB total)
rather than split into per-file or content-addressed blob rows: at this size a
version is a single-row fetch, and a blob store would move tenancy out of a
column and into a reachability join.

No data migration: both tables start empty.

Revision ID: f2c9a4d7b103
Revises: 43932ee1b7e1
Create Date: 2026-08-13 18:30:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f2c9a4d7b103"
down_revision: str | Sequence[str] | None = "43932ee1b7e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "skills",
        sa.Column("skill_id", sa.String(), nullable=False),
        sa.Column("org_id", sa.String(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("icon_emoji", sa.String(), nullable=True),
        sa.Column(
            "visibility", sa.Text(), nullable=False, server_default="org"
        ),
        sa.Column("origin", sa.Text(), nullable=False, server_default="authored"),
        sa.Column("runtimes", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("forked_from_skill_id", sa.Text(), nullable=True),
        sa.Column("forked_from_version_id", sa.Text(), nullable=True),
        sa.Column("latest_version_id", sa.Text(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("skill_id"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.org_id"]),
        sa.ForeignKeyConstraint(["created_by"], ["human_users.id"]),
        # Self-reference for fork lineage. NO cascade: deleting the source skill
        # must never delete its forks — they belong to whoever forked them.
        sa.ForeignKeyConstraint(["forked_from_skill_id"], ["skills.skill_id"]),
        sa.CheckConstraint(
            "visibility IN ('private', 'org', 'public')",
            name="skills_visibility_check",
        ),
        sa.CheckConstraint(
            "origin IN ('authored', 'forked', 'imported')",
            name="skills_origin_check",
        ),
    )
    # Unique among LIVE skills only. Deletes are soft, so a plain UNIQUE would
    # let a deleted skill burn its slug in that org forever — and the slug is
    # the on-disk directory name a user will reasonably want to reuse.
    op.create_index(
        "uq_skills_org_slug",
        "skills",
        ["org_id", "slug"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.create_index("ix_skills_org", "skills", ["org_id"])

    op.create_table(
        "skill_versions",
        sa.Column("version_id", sa.String(), nullable=False),
        sa.Column("skill_id", sa.String(), nullable=False),
        sa.Column("version", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        sa.Column(
            "manifest", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column("body_md", sa.Text(), nullable=False),
        sa.Column("files", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("total_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "has_executable",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("changelog", sa.String(), nullable=True),
        sa.Column("schema_version", sa.Text(), nullable=False, server_default="1"),
        sa.Column("published_by", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("version_id"),
        sa.ForeignKeyConstraint(["skill_id"], ["skills.skill_id"]),
        sa.ForeignKeyConstraint(["published_by"], ["human_users.id"]),
        sa.UniqueConstraint(
            "skill_id", "version", name="uq_skill_versions_skill_version"
        ),
    )
    op.create_index("ix_skill_versions_skill", "skill_versions", ["skill_id"])
    op.create_index("ix_skill_versions_hash", "skill_versions", ["content_hash"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_skill_versions_hash", table_name="skill_versions")
    op.drop_index("ix_skill_versions_skill", table_name="skill_versions")
    op.drop_table("skill_versions")
    op.drop_index("ix_skills_org", table_name="skills")
    op.drop_index("uq_skills_org_slug", table_name="skills")
    op.drop_table("skills")

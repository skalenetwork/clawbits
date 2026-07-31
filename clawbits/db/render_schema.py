"""Render ``db_schema.md`` from SQLModel metadata.

Run with::

    uv run python -m clawbits.db.render_schema

Always overwrite the doc rather than editing it by hand — the source of truth
is :mod:`clawbits.db.models`.
"""
from __future__ import annotations

import pathlib

from sqlalchemy.dialects import postgresql
from sqlmodel import SQLModel

from clawbits.db import models  # noqa: F401  populate metadata

DIALECT = postgresql.dialect()

OVERVIEW: dict[str, str] = {
    "agents": "Agent (Clawbot) credentials, keys, balances.",
    "human_users": "Local mirror of WorkOS-managed humans.",
    "organizations": "Multi-tenant org boundary; mirrors a WorkOS organization.",
    "org_members": "Human ↔ organization membership with role.",
    "agent_claims": "Pending agent→email links, resolved on first WorkOS login.",
    "agent_signup_requests": "Owner-approval queue for agent signups.",
    "agent_profiles": "Agent display profile (bio, avatar, etc.).",
    "agent_actions": "Per-agent action specs keyed by action_id.",
    "agent_posts": "Public Twitter-style posts authored by agents.",
    "agent_usage_daily": "Per-agent daily rollup of token usage and cost (by model + provider).",
    "agent_usage_events": "Raw per-call agent usage events (deduped on agent_id + event_id).",
    "post_likes": "Likes on agent_posts (by agent or human).",
    "post_comments": "Comments on agent_posts (by agent or human).",
    "repositories": "Per-org git repositories.",
    "share_records": "Metadata for shared files (R2 objects).",
    "challenge_sessions": "Proof-of-Cognition challenge sessions.",
    "mm_channels": "Mattermost-style channels (public / private / direct).",
    "mm_channel_members": "Channel membership (agent or human).",
    "mm_posts": "Channel messages with streaming / draft / published lifecycle.",
    "human_channel_state": "Per-human read pointer + mute state per channel.",
}


def _render_constraints(table) -> list[str]:
    # ``table.constraints`` is a set — sort by name for deterministic output
    # so CI's drift check doesn't flap.
    out: list[str] = []
    for c in sorted(table.constraints, key=lambda c: (c.__class__.__name__, c.name or "")):
        cls = c.__class__.__name__
        # Skip unnamed auto-constraints from `unique=True` on a Field — the
        # per-column "unique" flag already conveys those.
        if c.name is None:
            continue
        if cls == "UniqueConstraint":
            cols = [col.name for col in c.columns]
            out.append(f"- **Unique** `{c.name}`: ({', '.join(cols)})")
        elif cls == "CheckConstraint":
            out.append(f"- **Check** `{c.name}`: `{c.sqltext}`")
    return out


def render() -> str:
    lines: list[str] = []
    lines.append("# Clawbits Database Schema")
    lines.append("")
    lines.append(
        "Generated from `clawbits/db/models.py` against the Postgres dialect. "
        "**Do not edit by hand** — regenerate via "
        "`uv run python -m clawbits.db.render_schema`."
    )
    lines.append("")
    lines.append("## Table overview")
    lines.append("")
    for tname in sorted(SQLModel.metadata.tables.keys()):
        desc = OVERVIEW.get(tname, "")
        lines.append(f"- **{tname}** — {desc}")
    lines.append("")
    lines.append("---")
    lines.append("")
    for table in sorted(SQLModel.metadata.tables.values(), key=lambda x: x.name):
        lines.append(f"## {table.name}")
        lines.append("")
        lines.append("| Column | Type | Notes |")
        lines.append("|---|---|---|")
        for col in table.columns:
            notes: list[str] = []
            if col.primary_key:
                notes.append("PK")
            if not col.nullable and not col.primary_key:
                notes.append("NOT NULL")
            if col.unique:
                notes.append("unique")
            if col.index:
                notes.append("index")
            for fk in col.foreign_keys:
                notes.append(f"→ `{fk.target_fullname}`")
            if col.computed is not None:
                # Generated column (e.g. a tsvector). Its ``server_default`` is
                # the ``Computed`` construct, which exposes ``.sqltext`` rather
                # than the ``.arg`` a plain server default carries.
                sqltext = col.computed.sqltext
                txt = sqltext.text if hasattr(sqltext, "text") else str(sqltext)
                notes.append(f"generated `{txt}`")
            elif col.server_default is not None:
                arg = col.server_default.arg
                txt = arg.text if hasattr(arg, "text") else str(arg)
                notes.append(f"default `{txt}`")
            lines.append(
                f"| `{col.name}` | `{col.type.compile(DIALECT)}` | "
                f"{', '.join(notes) or '—'} |"
            )
        for extra in _render_constraints(table):
            lines.append("")
            lines.append(extra)
        lines.append("")
    return "\n".join(lines) + "\n"


def main() -> None:
    out = pathlib.Path(__file__).with_name("db_schema.md")
    out.write_text(render())
    print(f"wrote {out}")


if __name__ == "__main__":
    main()

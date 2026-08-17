#!/usr/bin/env python
"""Populate a LOCAL dev org with a believable roster: people, agents, channels, DMs.

Built for demo recordings. An empty org films badly - the sidebar is short,
avatars are absent, every list reads as a fixture. This fills one org with
enough people, agents, channels and conversation that the UI looks like a
place where work happens.

Everything it creates is TAGGED and reversible: humans get
``<handle>@seed.clawbits.dev`` addresses, agents get ids from a fixed cast
list, and ``--reset`` deletes exactly those and the channels/posts hanging off
them. Nothing pre-existing is touched.

LOCAL ONLY. It refuses to run unless the resolved database URL points at
localhost/127.0.0.1 - the whole point is fake data, which has no business in a
deployed environment. --i-know-what-im-doing overrides, deliberately verbose.

Channel rows are written through the same TableWrite helpers the endpoints
use, so naming, membership and DM conventions match what the app creates:
human-human DMs are ``dm-human-<lo>-human-<hi>``, human-agent DMs are
``dm-human-<h>-agent-<a>``, both with ``channel_type='direct'``.

Not covered: channel avatars. The endpoints await an R2 upload
(avatar_hooks.await_channel_avatar) that needs bucket credentials this script
does not assume. Seeded channels fall back to whatever the client renders
without one; DMs are unaffected (they draw a member stack client-side).

Usage:
    uv run python scripts/seed_dev_org.py --owner you@example.com
    uv run python scripts/seed_dev_org.py --org user-2 --humans 14 --agents 7
    uv run python scripts/seed_dev_org.py --org user-2 --reset
"""
from __future__ import annotations

import argparse
import os
import random
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import delete, text  # noqa: E402

# select comes from sqlmodel, not sqlalchemy: Session.exec() is SQLModel's and
# only returns model instances for a SQLModel select. Handed a SQLAlchemy one
# it yields Rows instead, and every attribute access fails with AttributeError.
from sqlmodel import Session, select  # noqa: E402

from clawbits.datastructures.agent_id import AgentId  # noqa: E402
from clawbits.datastructures.long_name import LongName  # noqa: E402
from clawbits.datastructures.nickname import NickName  # noqa: E402
from clawbits.db.engine import get_database_url, get_engine  # noqa: E402
from clawbits.db.models import (  # noqa: E402
    Agent,
    AgentProfile,
    HumanUser,
    MmChannel,
    MmChannelMember,
    MmPost,
    OrgMember,
)
from clawbits.db.table_write import TableWrite  # noqa: E402

SEED_DOMAIN = "seed.clawbits.dev"

# A cast, not a generator. Random name salad reads as filler on screen; these
# are chosen to look like a real small company and to vary in length so the
# sidebar has a natural ragged edge.
PEOPLE = [
    ("Mara Ellison", "mara"), ("Priya Raman", "priya"), ("Josh Neumann", "josh"),
    ("Ana Beltrán", "ana"), ("Tom Okafor", "tom"), ("Lena Fischer", "lena"),
    ("Sam Whitfield", "sam"), ("Yuki Tanaka", "yuki"), ("Dan Brennan", "dan"),
    ("Nour Haddad", "nour"), ("Ivy Chen", "ivy"), ("Marco Rossi", "marco"),
    ("Kate Lindqvist", "kate"), ("Omar Faruq", "omar"), ("Ruth Adeyemi", "ruth"),
]

AGENTS = [
    ("scout", "Scout", "Watches CI and triages failures"),
    ("quill", "Quill", "Drafts and edits written work"),
    ("ledger", "Ledger", "Tracks invoices and spend"),
    ("atlas", "Atlas", "Keeps the roadmap and specs current"),
    ("pulse", "Pulse", "Monitors production and pages on drift"),
    ("forge", "Forge", "Builds and ships release artifacts"),
    ("harbor", "Harbor", "Handles inbound mail and scheduling"),
    ("sift", "Sift", "Summarises long threads and docs"),
]

CHANNELS = [
    ("engineering", "Engineering"), ("design", "Design"), ("general", "General"),
    ("incidents", "Incidents"), ("releases", "Releases"), ("support", "Support"),
    ("hiring", "Hiring"), ("random", "Random"), ("product", "Product"),
    ("infra", "Infra"),
]

HUMAN_LINES = [
    "can you check the deploy? it went out about ten minutes ago",
    "the prod dashboard is showing a spike since 14:02",
    "anyone have notes from yesterday's client call?",
    "shipping this today if nobody objects",
    "I pushed the change, pipeline is running now",
    "we're blocked on the migration until infra signs off",
    "good morning everyone",
    "that invoice came through, marking it paid",
    "the new onboarding copy is ready for review",
    "rolled back, the error rate is already dropping",
    "who owns the billing integration these days?",
    "let's pick this up in standup tomorrow",
    "nice - that's the third one this week",
    "I'll take it",
    "can someone sanity check these numbers before I send them",
    "moved the meeting to 3pm, calendar is updated",
    "the flaky test is back, same one as last sprint",
    "approved, go ahead",
]

AGENT_LINES = [
    "on it - pulling the logs now",
    "the failure is in the auth middleware, not the migration. opening a PR",
    "3 invoices arrived overnight, all matched to POs. one needs a manual check",
    "deploy #482 is green. 1m 51s, no regressions",
    "summarised the thread: two decisions, one open question. posted above",
    "error rate spiked at 14:02, right after deploy #482 - want the diff?",
    "I dropped an index on invoices.org_id, that query is 40x faster now",
    "drafted the release notes from the merged PRs, ready for a read",
    "reminder: the client call is in 20 minutes",
    "checked the CI logs - it's the same flaky test, quarantining it",
    "done. anything else on this?",
    "that's outside what I can reach - you'll need to grant repo access",
]


def die(msg: str) -> None:
    print(f"\n  {msg}\n", file=sys.stderr)
    raise SystemExit(1)


def guard_local(force: bool) -> None:
    url = get_database_url()
    local = any(h in url for h in ("localhost", "127.0.0.1", "@db", "0.0.0.0"))
    shown = url.split("@")[-1] if "@" in url else url
    if local:
        print(f"  database: {shown}")
        return
    if force:
        print(f"  !! NON-LOCAL DATABASE {shown} - proceeding on --i-know-what-im-doing")
        return
    die(f"refusing to seed fake data into a non-local database: {shown}")


def resolve_org(session: Session, org_id: str | None, owner: str | None) -> tuple[str, int]:
    """Return (org_id, owner_human_id). Owner is whoever owns the org."""
    if owner:
        human = session.exec(select(HumanUser).where(HumanUser.email == owner)).first()
        if human is None:
            die(f"no human_users row for {owner}")
        member = session.exec(
            select(OrgMember).where(OrgMember.human_id == human.id, OrgMember.role == "owner")
        ).first()
        if member is None:
            die(f"{owner} does not own any org")
        return member.org_id, human.id

    if not org_id:
        die("pass --org or --owner")
    member = session.exec(
        select(OrgMember).where(OrgMember.org_id == org_id, OrgMember.role == "owner")
    ).first()
    if member is None:
        die(f"org {org_id} has no owner row")
    return org_id, member.human_id


def reset(session: Session, org_id: str) -> None:
    """Remove only what this script creates, leaving real rows alone."""
    seeded_humans = [
        r[0] for r in session.execute(
            select(HumanUser.id).where(HumanUser.email.like(f"%@{SEED_DOMAIN}"))
        )
    ]
    seeded_agents = [a[0] for a in AGENTS]

    chans = [
        r[0] for r in session.execute(
            select(MmChannel.channel_id).where(MmChannel.org_id == org_id)
        )
    ]
    keep, drop = [], []
    for cid in chans:
        members = session.execute(
            select(MmChannelMember).where(MmChannelMember.channel_id == cid)
        ).all()
        touched = any(
            (m[0].human_id in seeded_humans) or (m[0].agent_id in seeded_agents)
            for m in members
        )
        (drop if touched else keep).append(cid)

    for cid in drop:
        session.execute(delete(MmPost).where(MmPost.channel_id == cid))
        session.execute(delete(MmChannelMember).where(MmChannelMember.channel_id == cid))
        session.execute(delete(MmChannel).where(MmChannel.channel_id == cid))
    if seeded_humans:
        session.execute(delete(OrgMember).where(OrgMember.human_id.in_(seeded_humans)))
        session.execute(delete(HumanUser).where(HumanUser.id.in_(seeded_humans)))
    session.execute(
        text("DELETE FROM agent_profiles WHERE agent_id = ANY(:ids)"), {"ids": seeded_agents}
    )
    session.execute(delete(Agent).where(Agent.agent_id.in_(seeded_agents)))
    session.commit()
    print(f"  reset: {len(drop)} channels, {len(seeded_humans)} humans, {len(seeded_agents)} agents removed")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--org", default=None, help="org id, e.g. user-2")
    ap.add_argument("--owner", default=None, help="owner email; resolves the org for you")
    ap.add_argument("--humans", type=int, default=12)
    ap.add_argument("--agents", type=int, default=6)
    ap.add_argument("--channels", type=int, default=8)
    ap.add_argument("--messages", type=int, default=18, help="max posts per channel")
    ap.add_argument("--dms", type=int, default=8)
    ap.add_argument("--reset", action="store_true", help="remove seeded rows, then exit")
    ap.add_argument("--seed", type=int, default=7, help="RNG seed, for repeatable runs")
    ap.add_argument("--i-know-what-im-doing", action="store_true", dest="force")
    args = ap.parse_args(argv)

    guard_local(args.force)
    rng = random.Random(args.seed)

    with Session(get_engine()) as session:
        org_id, owner_id = resolve_org(session, args.org, args.owner)
        print(f"  org: {org_id}  owner human_id: {owner_id}")

        if args.reset:
            reset(session, org_id)
            return 0

        # --- people -------------------------------------------------------
        humans: list[tuple[int, str]] = []
        for name, handle in PEOPLE[: args.humans]:
            email = f"{handle}@{SEED_DOMAIN}"
            existing = session.exec(select(HumanUser).where(HumanUser.email == email)).first()
            if existing:
                hid = existing.id
            else:
                hid = TableWrite.create_human_user(
                    session, email=email, workos_user_id=f"dev:{email}", display_name=name
                )
                TableWrite.add_org_member(session, org_id, hid, role="member")
            humans.append((hid, name))
        session.commit()
        print(f"  humans: {len(humans)}")

        # --- agents -------------------------------------------------------
        agents: list[str] = []
        for aid, nick, blurb in AGENTS[: args.agents]:
            if session.get(Agent, aid) is None:
                # LongName is an IDENTIFIER (`[a-zA-Z0-9_]{1,128}`), not prose -
                # a sentence here fails validation. The human-readable blurb is
                # a profile description, set just below.
                TableWrite.create_agent(session, AgentId(aid), NickName(nick), LongName(nick))
            TableWrite.set_agent_org_and_operator(session, aid, org_id, owner_id)
            # create_agent seeds a generic placeholder ("A fresh Clawbot...");
            # overwrite it so the agent cards read as a real roster on screen.
            profile = session.get(AgentProfile, aid)
            if profile is not None:
                profile.description = blurb
                profile.description_source = "default"
            agents.append(aid)
        session.commit()
        print(f"  agents: {len(agents)}")

        # --- public channels ---------------------------------------------
        made = 0
        for name, display in CHANNELS[: args.channels]:
            dup = session.exec(
                select(MmChannel).where(MmChannel.org_id == org_id, MmChannel.name == name)
            ).first()
            if dup:
                continue
            cid = str(uuid.uuid4())
            TableWrite.create_mm_channel(
                session, cid, name, "public", display_name=display,
                org_id=org_id, created_by_human=owner_id,
            )
            TableWrite.add_mm_channel_member_human(session, cid, owner_id)
            for hid, _ in rng.sample(humans, k=min(len(humans), rng.randint(4, 9))):
                TableWrite.add_mm_channel_member_human(session, cid, hid)
            for aid in rng.sample(agents, k=min(len(agents), rng.randint(1, 3))):
                TableWrite.add_mm_channel_member(session, cid, aid)

            members = session.execute(
                select(MmChannelMember).where(MmChannelMember.channel_id == cid)
            ).all()
            human_ids = [m[0].human_id for m in members if m[0].human_id]
            agent_ids = [m[0].agent_id for m in members if m[0].agent_id]
            for _ in range(rng.randint(max(4, args.messages // 2), args.messages)):
                if agent_ids and rng.random() < 0.35:
                    TableWrite.create_mm_post(
                        session, cid, rng.choice(agent_ids), rng.choice(AGENT_LINES)
                    )
                else:
                    TableWrite.create_mm_post_human(
                        session, cid, rng.choice(human_ids), rng.choice(HUMAN_LINES)
                    )
            made += 1
        session.commit()
        print(f"  channels: {made}")

        # --- DMs ----------------------------------------------------------
        dms = 0
        owner_row = session.get(HumanUser, owner_id)
        owner_name = owner_row.display_name or owner_row.email

        for aid in agents[: max(1, args.dms // 2)]:
            name = f"dm-human-{owner_id}-agent-{aid}"
            if session.exec(select(MmChannel).where(MmChannel.name == name)).first():
                continue
            cid = str(uuid.uuid4())
            TableWrite.create_mm_channel(
                session, cid, name, "direct",
                display_name=f"DM: {owner_name} ↔ {aid}", org_id=org_id,
            )
            TableWrite.add_mm_channel_member_human(session, cid, owner_id)
            TableWrite.add_mm_channel_member(session, cid, aid)
            for i in range(rng.randint(3, 8)):
                if i % 2:
                    TableWrite.create_mm_post(session, cid, aid, rng.choice(AGENT_LINES))
                else:
                    TableWrite.create_mm_post_human(
                        session, cid, owner_id, rng.choice(HUMAN_LINES)
                    )
            dms += 1

        for hid, hname in humans[: args.dms - dms]:
            lo, hi = sorted([owner_id, hid])
            name = f"dm-human-{lo}-human-{hi}"
            if session.exec(select(MmChannel).where(MmChannel.name == name)).first():
                continue
            cid = str(uuid.uuid4())
            TableWrite.create_mm_channel(
                session, cid, name, "direct",
                display_name=f"DM: {owner_name} ↔ {hname}", org_id=org_id,
            )
            TableWrite.add_mm_channel_member_human(session, cid, owner_id)
            TableWrite.add_mm_channel_member_human(session, cid, hid)
            for i in range(rng.randint(3, 9)):
                TableWrite.create_mm_post_human(
                    session, cid, owner_id if i % 2 else hid, rng.choice(HUMAN_LINES)
                )
            dms += 1
        session.commit()
        print(f"  dms: {dms}")

    print("\n  done\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

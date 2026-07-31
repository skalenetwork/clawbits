"""One-shot CLI: fetch + upload avatars for every existing row.

Run after a generator change (or a fresh deploy) to populate R2 for
users / agents / channels that don't have their current-version object
yet. Re-running is safe — each entity is HEAD-checked first and
skipped if its versioned object already exists.

The script also implements the **version bump** path: when a row is
still on ``avatar_version=1`` (the legacy in-house marble synth) we
bump it to ``CURRENT_AVATAR_VERSION`` and upload the new DiceBear-
sourced SVG at the new versioned URL. The old v1 object stays in R2
until a sweep removes it — leaving it doesn't hurt anything.

Usage::

    uv run python -m clawbits.avatars.backfill                  # idempotent fill + version-bump
    uv run python -m clawbits.avatars.backfill --force          # re-upload even if object exists
    uv run python -m clawbits.avatars.backfill --skip-if-current
                                                                # exit 0 fast if no row is behind
                                                                # CURRENT_AVATAR_VERSION, so a rerun
                                                                # on a current DB costs one query

Credentials come from the standard ``CLOUDFLARE_ACCOUNT_ID`` /
``CLOUDFLARE_API_TOKEN`` env vars; the bucket + public domain come
from ``CLAWBITS_AVATARS_BUCKET`` + ``CLAWBITS_AVATARS_DOMAIN``.

When to run it
-------------
Manually, after bumping ``CURRENT_AVATAR_VERSION``:

    python -m clawbits.avatars.backfill --force

This used to run on every container boot with ``--skip-if-current``, which was
a no-op in practice: every creation site stamps ``CURRENT_AVATAR_VERSION`` or
higher, so ``avatar_version < CURRENT`` can only be re-entered by a version
bump — a deliberate act with a deliberate rerun. It was removed from the boot
chain in the pre-open-source cleanup.

Rows that are behind render as initial-letter chips until this runs, so a
delayed backfill degrades appearance and nothing else.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from sqlalchemy import func
from sqlmodel import Session, select

from clawbits.avatars.config import CURRENT_AVATAR_VERSION, make_avatars_r2_client
from clawbits.avatars.service import (
    AvatarKind,
    ensure_agent_avatar,
    ensure_channel_avatar,
    ensure_user_avatar,
)
from clawbits.avatars.storage import (
    agent_avatar_object_key,
    channel_avatar_object_key,
    user_avatar_object_key,
)
from clawbits.cloudflare.r2_s3_client import R2S3Client
from clawbits.db.engine import get_engine
from clawbits.db.models import Agent, HumanUser, MmChannel

logger = logging.getLogger(__name__)

# ``CURRENT_AVATAR_VERSION`` is the source of truth in
# :mod:`clawbits.avatars.config` so creation hooks and the backfill
# agree on the current visual identity.


async def _exists(r2: R2S3Client, object_key: str) -> bool:
    """HEAD an R2 object — True if it's there, False on 404 / error.

    HEAD is the right shape here; we don't need the bytes, just whether
    we'd be overwriting work the previous backfill run already did.
    """
    info = await r2.get_file_info(object_key)
    return bool(info.get("success"))


async def _backfill_users(r2: R2S3Client, session: Session, force: bool) -> int:
    n = 0
    for user in session.exec(select(HumanUser)).all():
        if user.id is None:
            continue
        # Bump legacy rows so the URL path changes (new SVG => new URL
        # => no stale browser cache). New rows already start at the
        # current version via the TableWrite default.
        if user.avatar_version < CURRENT_AVATAR_VERSION:
            user.avatar_version = CURRENT_AVATAR_VERSION
            session.add(user)
            session.flush()
        key = user_avatar_object_key(user.id, user.avatar_version)
        if not force and await _exists(r2, key):
            continue
        await ensure_user_avatar(
            r2,
            user_id=user.id,
            version=user.avatar_version,
            kind=AvatarKind(user.avatar_kind),
        )
        n += 1
        logger.info("user avatar uploaded: id=%s key=%s", user.id, key)
    session.commit()
    return n


async def _backfill_agents(r2: R2S3Client, session: Session, force: bool) -> int:
    n = 0
    for agent in session.exec(select(Agent)).all():
        if agent.avatar_version < CURRENT_AVATAR_VERSION:
            agent.avatar_version = CURRENT_AVATAR_VERSION
            session.add(agent)
            session.flush()
        key = agent_avatar_object_key(agent.agent_id, agent.avatar_version)
        if not force and await _exists(r2, key):
            continue
        await ensure_agent_avatar(
            r2,
            agent_id=agent.agent_id,
            version=agent.avatar_version,
            kind=AvatarKind(agent.avatar_kind),
        )
        n += 1
        logger.info("agent avatar uploaded: id=%s key=%s", agent.agent_id, key)
    session.commit()
    return n


async def _backfill_channels(r2: R2S3Client, session: Session, force: bool) -> int:
    n = 0
    for ch in session.exec(select(MmChannel)).all():
        if ch.avatar_version < CURRENT_AVATAR_VERSION:
            ch.avatar_version = CURRENT_AVATAR_VERSION
            session.add(ch)
            session.flush()
        key = channel_avatar_object_key(ch.channel_id, ch.avatar_version)
        if not force and await _exists(r2, key):
            continue
        await ensure_channel_avatar(
            r2,
            channel_id=ch.channel_id,
            version=ch.avatar_version,
            channel_type=ch.channel_type,
        )
        n += 1
        logger.info("channel avatar uploaded: id=%s key=%s", ch.channel_id, key)
    session.commit()
    return n


def _count_pending_rows(session: Session) -> int:
    """Number of user / agent / channel rows still on a pre-current version.

    Cheap aggregate — three indexed ``SELECT COUNT(*) WHERE
    avatar_version < N`` queries. Used by ``--skip-if-current`` to
    short-circuit when no row is behind, so a rerun on a current
    don't pay N round-trips to R2 just to learn nothing's to do.

    Note: this only catches rows whose DB version is behind. It does
    NOT detect rows whose DB version is current but whose R2 object
    is missing (e.g. an interrupted prior backfill). Those gaps stay
    rendered as the initial-letter fallback until ops runs the
    backfill without ``--skip-if-current``.
    """
    n_users = session.exec(
        select(func.count()).select_from(HumanUser).where(
            HumanUser.avatar_version < CURRENT_AVATAR_VERSION
        )
    ).one()
    n_agents = session.exec(
        select(func.count()).select_from(Agent).where(
            Agent.avatar_version < CURRENT_AVATAR_VERSION
        )
    ).one()
    n_channels = session.exec(
        select(func.count()).select_from(MmChannel).where(
            MmChannel.avatar_version < CURRENT_AVATAR_VERSION
        )
    ).one()
    return int(n_users) + int(n_agents) + int(n_channels)


async def main(force: bool, skip_if_current: bool) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if skip_if_current:
        # Fast-path: open a tiny DB session, count rows behind the
        # current version, exit immediately if zero. Saves the
        # bucket/domain log line + the R2 client construction in the
        # common case (every restart on an already-backfilled deploy).
        with Session(get_engine()) as session:
            pending = _count_pending_rows(session)
        if pending == 0:
            logger.info(
                "backfill skipped: all rows already on v%s",
                CURRENT_AVATAR_VERSION,
            )
            return 0
        logger.info(
            "backfill needed: %s row(s) behind v%s",
            pending, CURRENT_AVATAR_VERSION,
        )

    # Avatars live in their own per-env bucket — see
    # :mod:`clawbits.avatars.config`. Falls back to the legacy
    # ``CLOUDFLARE_BUCKET`` when ``CLAWBITS_AVATARS_BUCKET`` is unset.
    r2 = make_avatars_r2_client()
    logger.info(
        "backfill target: bucket=%s domain=%s", r2.bucket_name, r2.custom_domain
    )
    with Session(get_engine()) as session:
        users = await _backfill_users(r2, session, force)
        agents = await _backfill_agents(r2, session, force)
        channels = await _backfill_channels(r2, session, force)
    logger.info(
        "backfill complete: users=%s agents=%s channels=%s", users, agents, channels
    )
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-upload even when the versioned object already exists in R2.",
    )
    parser.add_argument(
        "--skip-if-current",
        action="store_true",
        help=(
            "Exit 0 fast when no DB row is behind CURRENT_AVATAR_VERSION. "
            "Exit immediately when no row is behind, so a rerun on a "
            "cost only a single aggregate SQL query, not N R2 round-trips."
        ),
    )
    args = parser.parse_args()
    sys.exit(asyncio.run(main(force=args.force, skip_if_current=args.skip_if_current)))

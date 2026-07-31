"""One-shot CLI: probe and persist image dimensions on legacy ``mm_files``.

Run after deploying the server-side dim-probe path to fill in
``width``/``height`` on rows that were uploaded before the probe existed
(or whose upload bypassed it for any reason — Canvas decode failure on
the client, headless agent uploads, etc.). Re-running is safe: rows
that already have both dims are skipped without an R2 fetch.

The frontend reserves the image's aspect-ratio box at first paint using
these values; missing them makes the message row resize when the bytes
arrive, which is the layout shift the chat-scroll rewrite is trying to
eliminate. Once this script has been run, the rendered fallback for
"no dims known" should be exceptionally rare.

Usage::

    uv run python -m clawbits.fastapi.mm_file_dimensions_backfill
    uv run python -m clawbits.fastapi.mm_file_dimensions_backfill --limit 100
    uv run python -m clawbits.fastapi.mm_file_dimensions_backfill --skip-if-current

Credentials come from the standard R2 env vars
(``CLOUDFLARE_ACCOUNT_ID`` / ``R2_ACCESS_KEY_ID`` / ``R2_SECRET_ACCESS_KEY``);
the bucket name comes from ``CLOUDFLARE_BUCKET``.
"""
from __future__ import annotations

import argparse
import asyncio
import logging

from sqlalchemy import and_, func, or_
from sqlmodel import Session, select

from clawbits.cloudflare.r2_presign import R2Presigner
from clawbits.cloudflare.setup_r2 import setup_r2_presigner
from clawbits.db.engine import get_engine
from clawbits.db.models import MmFile
from clawbits.fastapi.mm_file_helpers import probe_image_dimensions

logger = logging.getLogger(__name__)


def _candidates_filter() -> object:
    """SQL predicate for rows that need a probe.

    An image is a candidate when:
      * ``status == "uploaded"`` (we never probe pending rows — the
        bytes might not be in R2 yet)
      * ``content_type`` starts with ``image/``
      * either ``width`` or ``height`` is NULL
    """
    return and_(
        MmFile.status == "uploaded",
        MmFile.content_type.startswith("image/"),  # type: ignore[attr-defined]
        or_(MmFile.width.is_(None), MmFile.height.is_(None)),  # type: ignore[union-attr]
    )


def _count_candidates(session: Session) -> int:
    return int(
        session.exec(
            select(func.count()).select_from(MmFile).where(_candidates_filter())
        ).one()
    )


async def _probe_one(
    presigner: R2Presigner,
    session: Session,
    row: MmFile,
) -> bool:
    """Probe dims for one row, persist if successful. Returns True on update."""
    # Prefer the thumbnail when one exists — it's a small JPEG, faster
    # to fetch than the original, and shares the original's aspect ratio.
    probe_key = row.thumbnail_object_key or row.object_key
    dims = await probe_image_dimensions(presigner, probe_key)
    if dims is None:
        logger.warning("probe failed: file_id=%s key=%s", row.file_id, probe_key)
        return False
    w, h = dims
    row.width = w
    row.height = h
    session.add(row)
    session.flush()
    logger.info("probed file_id=%s -> %dx%d", row.file_id, w, h)
    return True


async def main(limit: int | None, skip_if_current: bool) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    with Session(get_engine()) as session:
        pending = _count_candidates(session)

    if skip_if_current and pending == 0:
        logger.info("mm_files dim-backfill skipped: no candidates")
        return 0

    logger.info("mm_files dim-backfill candidates: %d", pending)
    if pending == 0:
        return 0

    # Use the bucket-aware factory, NOT a bare R2Presigner(): the bare
    # constructor defaults to CLOUDFLARE_BUCKET (share records) while chat
    # attachments live in MM_FILES_BUCKET, so every probe 404'd and this
    # backfill silently did nothing from the day it was written.
    presigner = setup_r2_presigner()
    if presigner is None:
        logger.error("cannot construct presigner (missing R2 access keys)")
        return 1

    updated = 0
    failed = 0
    with Session(get_engine()) as session:
        stmt = select(MmFile).where(_candidates_filter())
        if limit is not None:
            stmt = stmt.limit(limit)
        rows = list(session.exec(stmt).all())
        for row in rows:
            ok = await _probe_one(presigner, session, row)
            if ok:
                updated += 1
            else:
                failed += 1
        session.commit()

    logger.info(
        "mm_files dim-backfill complete: updated=%d failed=%d remaining=%d",
        updated,
        failed,
        max(0, pending - updated),
    )
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Cap the number of rows processed in one run (default: all)",
    )
    parser.add_argument(
        "--skip-if-current",
        action="store_true",
        help="Exit 0 immediately if no rows need backfilling",
    )
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args.limit, args.skip_if_current)))

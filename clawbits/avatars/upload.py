"""User-uploaded avatar processing + R2 upload.

Pipeline for a user-supplied avatar:

  1. Validate content-type and size at the FastAPI layer.
  2. ``process_uploaded_avatar`` (this module): open with Pillow,
     auto-orient via EXIF, center-crop to a square, resize to
     ``TARGET_SIZE``, encode as WebP at quality 90 (transparency-safe,
     ~30% smaller than PNG, sharper than JPEG at the same size).
  3. Upload the resulting bytes to R2 under
     ``avatars/users/{id}/v{n}.webp`` with the standard year-long
     immutable cache header.
  4. Caller bumps ``HumanUser.avatar_kind = 'uploaded'`` and
     ``avatar_version = n`` in the same transaction.

The DB row is the source of truth for "is this the current avatar"
— old uploads stay in R2 (cheap; orphan sweep is a future cleanup).
"""
from __future__ import annotations

import logging
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

from clawbits.avatars.config import make_avatars_r2_client
from clawbits.avatars.storage import (
    AVATAR_CACHE_CONTROL,
    AVATAR_CONTENT_TYPE_WEBP,
    user_avatar_object_key,
)

logger = logging.getLogger(__name__)

# 256×256 covers every render site (88px profile header is the largest
# we use today, plus 2× retina = 176px). Going much larger inflates the
# WebP and gives no perceptual benefit at our render sizes.
TARGET_SIZE = 256

# WebP quality knob — 90 is the sweet spot. 80 is visibly lossy on
# photo content; 95+ doubles the file size for no perceived gain.
WEBP_QUALITY = 90

# Pillow's image-size DoS guard — refuses to decode anything bigger
# than this. Our endpoint caps the *byte* size separately; this
# guards against decompression bombs (tiny zlib that expands to GB).
Image.MAX_IMAGE_PIXELS = 64_000_000  # ~64MP, covers every phone camera

# Accept these inbound content types. Anything else gets rejected
# at the endpoint; the processor itself is forgiving (Pillow sniffs
# the format regardless of the wrapper claim).
ACCEPTED_CONTENT_TYPES = frozenset(
    {"image/png", "image/jpeg", "image/webp", "image/gif"}
)


class AvatarProcessError(ValueError):
    """Raised when an uploaded image can't be turned into an avatar.

    Wraps Pillow's various decode/format errors so the endpoint can
    map a single exception type to a 400.
    """


def process_uploaded_avatar(raw: bytes) -> bytes:
    """Open ``raw``, square-crop + resize, return WebP bytes.

    Single-pass pipeline:

    - ``Image.open`` will sniff the format from the magic bytes (we
      don't trust the wrapper's claimed content-type).
    - ``ImageOps.exif_transpose`` applies the EXIF Orientation tag so
      portrait phone shots aren't sideways after the crop.
    - We convert to ``RGBA`` so transparent PNGs / animated GIFs (first
      frame) don't blow up when we save as WebP.
    - ``ImageOps.fit`` does the center-square-crop in one call —
      shorter side becomes the crop axis, longer side is trimmed
      symmetrically.
    """
    try:
        img = Image.open(BytesIO(raw))
        img.load()  # force decode now so we catch errors here, not later
    except (UnidentifiedImageError, OSError) as exc:
        raise AvatarProcessError(f"unsupported image: {exc}") from exc

    img = ImageOps.exif_transpose(img)
    # Animated formats (GIF / WEBP) expose only the first frame after
    # ``Image.open`` + ``load``; that's the behaviour we want — avatars
    # are static. Explicit conversion to RGBA below also drops any
    # palette / mode quirks that would surface later.
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA")

    img = ImageOps.fit(img, (TARGET_SIZE, TARGET_SIZE), method=Image.Resampling.LANCZOS)

    out = BytesIO()
    img.save(out, format="WEBP", quality=WEBP_QUALITY, method=6)
    return out.getvalue()


async def upload_user_avatar_to_r2(
    *, user_id: int, version: int, processed_bytes: bytes
) -> None:
    """Upload the processed WebP to R2 at the user's versioned key.

    Caller is responsible for bumping ``avatar_version`` + flipping
    ``avatar_kind = 'uploaded'`` on the DB row *after* this returns
    successfully. Doing the R2 upload first means a DB-only failure
    leaves an orphan SVG (cheap) rather than a row pointing at a
    missing URL.
    """
    r2 = make_avatars_r2_client()
    object_key = user_avatar_object_key(user_id, version, kind="uploaded")
    result = await r2.upload_file(
        object_key,
        processed_bytes,
        content_type=AVATAR_CONTENT_TYPE_WEBP,
        cache_control=AVATAR_CACHE_CONTROL,
    )
    if not result.get("success"):
        raise RuntimeError(
            f"avatar R2 upload failed: {result.get('error')}"
        )

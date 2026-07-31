"""Unit tests for the user-uploaded avatar processing pipeline."""
from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image

from clawbits.avatars.upload import (
    TARGET_SIZE,
    AvatarProcessError,
    process_uploaded_avatar,
)


def _make_image_bytes(
    *,
    size: tuple[int, int],
    mode: str = "RGB",
    fill: tuple[int, ...] | int = (200, 60, 60),
    fmt: str = "PNG",
) -> bytes:
    """Build a Pillow image and return its encoded bytes."""
    img = Image.new(mode, size, fill)
    buf = BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def _decode_output(raw: bytes) -> Image.Image:
    """Round-trip the WebP bytes back through Pillow for assertions."""
    return Image.open(BytesIO(raw))


def test_process_uploaded_avatar_outputs_target_square():
    raw = _make_image_bytes(size=(800, 400))
    processed = process_uploaded_avatar(raw)

    img = _decode_output(processed)
    assert img.format == "WEBP"
    assert img.size == (TARGET_SIZE, TARGET_SIZE)


def test_process_uploaded_avatar_handles_portrait_input():
    """Vertical input must be center-cropped to a square, not stretched."""
    raw = _make_image_bytes(size=(300, 900))
    processed = process_uploaded_avatar(raw)

    img = _decode_output(processed)
    assert img.size == (TARGET_SIZE, TARGET_SIZE)


def test_process_uploaded_avatar_converts_palette_to_rgba():
    """Palette / mode-P images would blow up on WebP encode without the
    intermediate convert. The processor must absorb that."""
    base = Image.new("P", (300, 300), 5)
    buf = BytesIO()
    base.save(buf, format="PNG")
    raw = buf.getvalue()

    processed = process_uploaded_avatar(raw)
    img = _decode_output(processed)
    assert img.mode in ("RGB", "RGBA")
    assert img.size == (TARGET_SIZE, TARGET_SIZE)


def test_process_uploaded_avatar_preserves_transparent_pngs():
    """Transparent corners on a circular avatar must survive the pipeline."""
    raw = _make_image_bytes(size=(400, 400), mode="RGBA", fill=(0, 0, 0, 0))
    processed = process_uploaded_avatar(raw)

    img = _decode_output(processed)
    # WebP supports alpha — bytes round-trip as RGBA.
    assert img.mode in ("RGB", "RGBA")
    assert img.size == (TARGET_SIZE, TARGET_SIZE)


def test_process_uploaded_avatar_accepts_jpeg_input():
    raw = _make_image_bytes(size=(640, 640), mode="RGB", fmt="JPEG")
    processed = process_uploaded_avatar(raw)
    img = _decode_output(processed)
    assert img.format == "WEBP"


def test_process_uploaded_avatar_rejects_garbage_bytes():
    with pytest.raises(AvatarProcessError):
        process_uploaded_avatar(b"this is definitely not an image")


def test_process_uploaded_avatar_first_frame_of_animated_gif():
    """Animated GIFs are common avatar uploads — we keep frame 0 and
    drop the rest (avatars are static)."""
    frames = [
        Image.new("RGB", (256, 256), (i * 50, 0, 0))
        for i in range(1, 4)
    ]
    buf = BytesIO()
    frames[0].save(
        buf,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=80,
        loop=0,
    )
    raw = buf.getvalue()

    processed = process_uploaded_avatar(raw)
    img = _decode_output(processed)
    assert img.format == "WEBP"
    assert img.size == (TARGET_SIZE, TARGET_SIZE)

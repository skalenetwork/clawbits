"""Unit tests for the SVG composer used to build channel / user avatars."""
from __future__ import annotations

import base64
import re

import pytest

from clawbits.avatars import icons
from clawbits.avatars.compose import (
    compose_stitched_glass,
    compose_with_icon,
    contrast_icon_color,
    extract_bg_color,
)

# ---------------------------------------------------------------------------
# extract_bg_color
# ---------------------------------------------------------------------------


def _glass_svg(bg_hex: str) -> str:
    """Build a fragment matching the DiceBear glass SVG header so the
    background regex has something to lock onto."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        f'<rect fill="{bg_hex}" width="100" height="100" x="0" y="0"/>'
        "</svg>"
    )


def test_extract_bg_color_matches_first_full_size_rect():
    svg = _glass_svg("#ff6b6b")
    assert extract_bg_color(svg) == "#ff6b6b"


def test_extract_bg_color_handles_bytes_input():
    svg = _glass_svg("#0EA5E9").encode("utf-8")
    assert extract_bg_color(svg) == "#0EA5E9"


def test_extract_bg_color_falls_back_when_pattern_missing():
    # Empty SVG — should yield the documented neutral grey fallback
    # rather than raising. Matches the inline _DEFAULT_BG constant.
    assert extract_bg_color("<svg></svg>") == "#888888"


# ---------------------------------------------------------------------------
# contrast_icon_color
# ---------------------------------------------------------------------------


def _hex_to_lightness(hex_str: str) -> float:
    import colorsys
    h = hex_str.lstrip("#")
    r = int(h[0:2], 16) / 255
    g = int(h[2:4], 16) / 255
    b = int(h[4:6], 16) / 255
    _, lightness, _ = colorsys.rgb_to_hls(r, g, b)
    return lightness


@pytest.mark.parametrize(
    "bg_hex",
    [
        "#ffffff",   # pure white
        "#fffbe6",   # near-white cream
        "#ffd166",   # warm pale yellow
    ],
)
def test_contrast_icon_color_darkens_light_backgrounds(bg_hex):
    """Light bg → near-black icon. We don't pin the exact value (it's a
    hue-preserving flip) but the result must be substantially darker."""
    out = contrast_icon_color(bg_hex)
    assert _hex_to_lightness(out) < 0.25, (bg_hex, out)


@pytest.mark.parametrize(
    "bg_hex",
    [
        "#0b0b0b",   # near-black
        "#1d4ed8",   # deep blue
        "#374151",   # cool slate
    ],
)
def test_contrast_icon_color_lightens_dark_backgrounds(bg_hex):
    out = contrast_icon_color(bg_hex)
    assert _hex_to_lightness(out) > 0.75, (bg_hex, out)


def test_contrast_icon_color_accepts_shorthand_hex():
    # #abc → #aabbcc — the function should pre-expand before parsing.
    out = contrast_icon_color("#abc")
    # Mid-grey-ish input: just confirm it returns a valid 6-digit hex.
    assert re.fullmatch(r"#[0-9a-f]{6}", out)


# ---------------------------------------------------------------------------
# compose_with_icon
# ---------------------------------------------------------------------------


def test_compose_with_icon_injects_group_before_closing_svg():
    base = _glass_svg("#ff6b6b")
    out = compose_with_icon(base.encode("utf-8"), icons.HASHTAG).decode("utf-8")

    # New <g> appended right before </svg>
    assert out.count("</svg>") == 1
    assert out.endswith("</svg>")
    # The injected group references the icon paths verbatim
    assert icons.HASHTAG in out
    # Group sets standard stroke geometry
    assert 'fill="none"' in out
    assert 'stroke-width="2"' in out


def test_compose_with_icon_respects_explicit_stroke_color():
    base = _glass_svg("#0b0b0b")  # dark bg → contrast helper would lighten
    out = compose_with_icon(
        base.encode("utf-8"), icons.LOCK_CLOSED, stroke_color="#000000"
    ).decode("utf-8")
    assert 'stroke="#000000"' in out


def test_compose_with_icon_derives_stroke_from_bg_when_unset():
    base = _glass_svg("#ffffff")
    out = compose_with_icon(base.encode("utf-8"), icons.HASHTAG).decode("utf-8")
    m = re.search(r'stroke="(#[0-9a-f]{6})"', out)
    assert m is not None
    # Light bg → dark stroke (matches contrast_icon_color contract).
    assert _hex_to_lightness(m.group(1)) < 0.25


def test_compose_with_icon_no_op_when_closing_tag_missing():
    # Defensive path — caller shouldn't reach this, but the composer
    # must not raise on a malformed SVG.
    out = compose_with_icon(b"<svg><g/>", icons.HASHTAG)
    assert b"</svg>" not in out


# ---------------------------------------------------------------------------
# compose_stitched_glass
# ---------------------------------------------------------------------------


def test_compose_stitched_glass_embeds_both_sources_as_base64():
    top = b'<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#fff"/></svg>'
    bot = b'<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#000"/></svg>'
    out = compose_stitched_glass(top, bot).decode("utf-8")

    # Single output SVG with our viewBox + two clip-paths + two images.
    assert out.count("<svg") == 1
    assert 'viewBox="0 0 100 100"' in out
    assert out.count("<clipPath") == 2
    assert out.count("<image") == 2

    # Both halves must round-trip through base64 so the consumer renders
    # the originals untouched.
    top_b64 = base64.b64encode(top).decode("ascii")
    bot_b64 = base64.b64encode(bot).decode("ascii")
    assert top_b64 in out
    assert bot_b64 in out

    # Geometry: top half clips y=0..50, bottom half clips y=50..100.
    assert 'clipPath id="t"' in out and 'y="0"' in out
    assert 'clipPath id="b"' in out and 'y="50"' in out

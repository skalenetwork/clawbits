"""Compose an identity icon over a DiceBear SVG.

Given the SVG bytes from a DiceBear ``glass`` render and an icon path
from :mod:`clawbits.avatars.icons`, inject a centered ``<g>`` with the
icon — tinted to the bg colour's hue but flipped for contrast (much
darker on light bgs, much lighter on dark bgs) so it reads as a single
composed mark, not a sticker pasted on top.

Server-side composition keeps the output canonical: one SVG per entity
in R2, identical on web and mobile, cacheable forever per version.
"""
from __future__ import annotations

import base64
import colorsys
import re

# Match the first ``<rect fill="#abc..." width="100" height="100" ...>``
# inside the masked glass content. DiceBear always emits the bg rect
# first so the first match is the right one.
_BG_RECT_RE = re.compile(
    r'<rect\s+fill="(#[0-9a-fA-F]{3,8})"\s+width="100"\s+height="100"'
)

# Fallback if the regex doesn't match (e.g. DiceBear output shape
# changes upstream). Neutral grey — we still inject the icon so the
# entity is identifiable, just without perfect colour harmony.
_DEFAULT_BG = "#888888"

# Icon size as a fraction of the 100×100 viewBox. 42% reads well at
# every UI size from sidebar tiles (26-36px) up to profile headers
# (88px) without overpowering the glass blobs underneath.
_ICON_FRAC = 0.42


def extract_bg_color(svg: str | bytes) -> str:
    """Return the bg ``#rrggbb`` hex (or :data:`_DEFAULT_BG` on miss)."""
    if isinstance(svg, bytes):
        svg = svg.decode("utf-8", errors="ignore")
    m = _BG_RECT_RE.search(svg)
    return m.group(1) if m else _DEFAULT_BG


def contrast_icon_color(bg_hex: str) -> str:
    """Hue-preserving contrast flip — aggressive.

    Light bg → near-black with the bg's hue.
    Dark bg → near-white with the bg's hue.
    Saturation is kept relatively high so the hue is recognisable —
    the icon reads as a *deep* or *bright* version of the bg colour,
    not a neutral grey. Stroke icons need much more contrast than
    filled shapes (thinner visual mass), so the L flip is wider than
    a typical "darken/lighten" tweak.
    """
    bg_hex = bg_hex.lstrip("#")
    if len(bg_hex) == 3:  # shorthand like #abc
        bg_hex = "".join(c * 2 for c in bg_hex)
    r = int(bg_hex[0:2], 16) / 255
    g = int(bg_hex[2:4], 16) / 255
    b = int(bg_hex[4:6], 16) / 255
    h, lightness, s = colorsys.rgb_to_hls(r, g, b)
    if lightness > 0.5:
        new_l = max(0.05, lightness * 0.10)
    else:
        new_l = min(0.98, 0.80 + (1 - lightness) * 0.18)
    new_s = max(0.25, s * 0.85)
    nr, ng, nb = colorsys.hls_to_rgb(h, new_l, new_s)
    return f"#{int(round(nr * 255)):02x}{int(round(ng * 255)):02x}{int(round(nb * 255)):02x}"


def compose_with_icon(
    svg: bytes,
    icon_paths: str,
    *,
    stroke_color: str | None = None,
) -> bytes:
    """Return SVG bytes with the icon overlaid on top of the glass blobs.

    ``icon_paths`` is the raw inner SVG (a sequence of stroke-based
    ``<path>`` elements in a 24×24 viewBox — see
    :mod:`clawbits.avatars.icons`). The overlay group sets the
    standard Hugeicons stroke attributes plus the ``stroke`` colour.

    ``stroke_color`` overrides the contrast computation when the caller
    wants a fixed colour (e.g. pure ``#ffffff`` for channel hash/lock
    icons that should read maximally clearly on every bg). When unset,
    the colour is derived from the bg via
    :func:`contrast_icon_color` — same hue, flipped lightness.
    """
    text = svg.decode("utf-8") if isinstance(svg, bytes) else svg
    if stroke_color is None:
        bg = extract_bg_color(text)
        stroke = contrast_icon_color(bg)
    else:
        stroke = stroke_color

    # The icon's native size is 24 units; we want it `_ICON_FRAC * 100`
    # units wide on screen. So scale = 100*frac/24, and translate to
    # center it (offset = (100 - icon_visible_size) / 2).
    icon_size = 100.0 * _ICON_FRAC
    scale = icon_size / 24.0
    offset = (100.0 - icon_size) / 2.0

    # stroke-width is in icon-local units (24×24), so it scales with
    # ``scale``. At icon-frac 0.42 and stroke-width 2, the rendered
    # line is roughly 2 * 1.75 = 3.5 units in the 100×100 viewBox,
    # which works out to ~1.3px at a 36px sidebar tile — readable
    # without looking heavy at larger sizes.
    overlay = (
        f'<g transform="translate({offset:.3f} {offset:.3f}) scale({scale:.4f})"'
        f' fill="none" stroke="{stroke}" stroke-width="2"'
        f' stroke-linecap="round" stroke-linejoin="round">'
        f'{icon_paths}'
        f'</g>'
    )

    # Inject as the last child before ``</svg>`` so it renders on top
    # of everything else. We don't need to worry about the masked
    # group — Cloudflare/browsers render the appended <g> in document
    # order regardless of the surrounding mask scope.
    if "</svg>" not in text:
        return text.encode("utf-8")
    return text.replace("</svg>", overlay + "</svg>", 1).encode("utf-8")


def compose_stitched_glass(top_svg: bytes, bottom_svg: bytes) -> bytes:
    """Stitch two DiceBear glass SVGs into a single tile.

    The top 50% shows ``top_svg``'s render and the bottom 50% shows
    ``bottom_svg``'s render — clipped via SVG ``<clipPath>`` so the
    two halves meet on a sharp horizontal line at y=50.

    Each source SVG is embedded as a base64 data URI inside an
    ``<image>`` element rather than inlined, so we don't have to
    re-namespace the ``<mask id="viewboxMask">`` IDs DiceBear emits
    (which would collide if both inlined). The size cost is small —
    base64 inflates each SVG by ~33%, so a stitched glass weighs in
    around 6-7KB vs ~2.5KB for a single render. Worth it for the
    visual variety.
    """
    top_b64 = base64.b64encode(top_svg).decode("ascii")
    bot_b64 = base64.b64encode(bottom_svg).decode("ascii")
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        '<defs>'
        '<clipPath id="t"><rect x="0" y="0" width="100" height="50"/></clipPath>'
        '<clipPath id="b"><rect x="0" y="50" width="100" height="50"/></clipPath>'
        '</defs>'
        f'<image x="0" y="0" width="100" height="100" href="data:image/svg+xml;base64,{top_b64}" clip-path="url(#t)"/>'
        f'<image x="0" y="0" width="100" height="100" href="data:image/svg+xml;base64,{bot_b64}" clip-path="url(#b)"/>'
        '</svg>'
    ).encode()

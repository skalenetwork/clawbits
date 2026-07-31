/**
 * Inline ``<image href="data:image/svg+xml;base64,...">`` elements into
 * a single self-contained SVG that can be rendered by react-native-svg.
 *
 * The backend's ``compose_stitched_glass`` (clawbits/avatars/compose.py)
 * emits a top-level SVG whose two halves are nested SVGs base64-embedded
 * inside ``<image>`` elements. Browsers' ``<img>`` and ``<svg>`` renderers
 * recursively decode SVG data URIs, but react-native-svg's ``<Image>``
 * only handles raster formats — so on iOS the stitched user avatars
 * come out as empty rectangles.
 *
 * This helper undoes the embedding entirely in JS: each inner SVG is
 * base64-decoded, stripped of its outer ``<svg>`` wrapper, given a
 * unique prefix on every declared ID (to avoid mask / gradient / filter
 * collisions between the two halves), and dropped back into the parent
 * SVG wrapped in a ``<g clip-path="...">`` that preserves the original
 * top / bottom clip.
 *
 * If the SVG doesn't contain any data-URI ``<image>`` elements, it's
 * returned unchanged — the function is safe to run on every avatar SVG
 * (channels, agents, uploaded raster fallbacks) and only does work on
 * stitched user tiles.
 */

const DATA_IMAGE_RE =
  /<image\b[^>]*?href="data:image\/svg\+xml;base64,([^"]+)"[^>]*?\/>/g;
const CLIP_PATH_RE = /clip-path="url\(#([^)]+)\)"/;
const SVG_OPEN_RE = /<svg\b[^>]*>/i;
const SVG_CLOSE_RE = /<\/svg>\s*$/i;
const VIEWBOX_RE = /viewBox\s*=\s*"([^"]+)"/i;

// Outer SVG from ``compose_stitched_glass`` uses a 100×100 viewBox and
// sizes each ``<image>`` at 100×100. The inner DiceBear SVGs have their
// own viewBox (typically 0 0 200 200); when we inline their content
// directly, we have to scale them to fit the same 100×100 box that the
// original ``<image>`` filled, otherwise only the top-left quadrant of
// each half shows up.
const OUTER_TILE_SIZE = 100;

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function parseViewBox(svgOpen: string): ViewBox | null {
  const m = VIEWBOX_RE.exec(svgOpen);
  if (!m) return null;
  const parts = m[1]!.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
  const [x, y, width, height] = parts as [number, number, number, number];
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** Build a ``transform="..."`` clause that maps a child's viewBox onto
 *  the outer 100×100 tile, matching the original ``<image x="0" y="0"
 *  width="100" height="100">`` placement. Returns empty string when the
 *  child viewBox is missing — the content is drawn unscaled. */
function fitTransform(vb: ViewBox | null): string {
  if (!vb) return '';
  const sx = OUTER_TILE_SIZE / vb.width;
  const sy = OUTER_TILE_SIZE / vb.height;
  const tx = -vb.x * sx;
  const ty = -vb.y * sy;
  return ` transform="translate(${tx} ${ty}) scale(${sx} ${sy})"`;
}

/** Decode base64 → utf-8 string. Uses the global ``atob`` shipped with
 *  Hermes (React Native 0.74+); falls back to a manual decode if missing
 *  so the helper is safe to call from any JS runtime. */
function decodeBase64(input: string): string {
  if (typeof atob === 'function') {
    // ``atob`` returns a binary string; reinterpret each char code as a
    // UTF-8 byte and decode. ``TextDecoder`` ships in Hermes too.
    const binary = atob(input);
    if (typeof TextDecoder !== 'undefined') {
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
    return binary;
  }
  throw new Error('atob is not available in this runtime');
}

/** Rewrite every ``id="..."`` and its references (``url(#...)``,
 *  ``href="#..."``, ``xlink:href="#..."``) by prefixing with ``prefix``.
 *  Each inner SVG gets a unique prefix so the two halves can safely
 *  share a parent without colliding on the ``viewboxMask`` / gradient /
 *  filter IDs DiceBear hardcodes. */
function rewriteIds(svgBody: string, prefix: string): string {
  const ids = new Set<string>();
  for (const match of svgBody.matchAll(/\sid="([^"]+)"/g)) {
    ids.add(match[1]!);
  }

  let result = svgBody;
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Declaration: ` id="foo"` → ` id="prefixfoo"`
    result = result.replace(
      new RegExp(`(\\sid=")${escaped}(")`, 'g'),
      `$1${prefix}${id}$2`,
    );
    // url(#foo) → url(#prefixfoo)
    result = result.replace(
      new RegExp(`(url\\(#)${escaped}(\\))`, 'g'),
      `$1${prefix}${id}$2`,
    );
    // href="#foo" / xlink:href="#foo" → href="#prefixfoo" / xlink:href="#prefixfoo"
    result = result.replace(
      new RegExp(`((?:xlink:)?href=")#${escaped}(")`, 'g'),
      `$1#${prefix}${id}$2`,
    );
  }
  return result;
}

/** Strip the outer ``<svg ...>...</svg>`` wrapper from an SVG document,
 *  returning just the inner markup. The wrapper carries width / height /
 *  viewBox attributes that would conflict with the parent SVG. */
function unwrapSvg(svgText: string): string {
  return svgText.replace(SVG_OPEN_RE, '').replace(SVG_CLOSE_RE, '');
}

/** Main entry point. See module docstring for behaviour. */
export function inlineDataUriImages(svgText: string): string {
  if (!svgText.includes('data:image/svg+xml;base64,')) {
    return svgText;
  }

  let index = 0;
  return svgText.replace(DATA_IMAGE_RE, (match, b64: string) => {
    const clipMatch = CLIP_PATH_RE.exec(match);
    const clipPath = clipMatch ? `url(#${clipMatch[1]})` : null;

    try {
      const inner = decodeBase64(b64);
      const openMatch = SVG_OPEN_RE.exec(inner);
      const vb = openMatch ? parseViewBox(openMatch[0]) : null;
      const transform = fitTransform(vb);
      const body = unwrapSvg(inner);
      const prefixed = rewriteIds(body, `s${index++}_`);
      // Outer ``<g>`` carries the clip-path so the half-tile boundary
      // is enforced in the outer coordinate space. Inner ``<g>`` carries
      // the transform that maps the child's viewBox down to a 100×100
      // tile — the clip-path stays in the parent's user space.
      return clipPath
        ? `<g clip-path="${clipPath}"><g${transform}>${prefixed}</g></g>`
        : `<g${transform}>${prefixed}</g>`;
    } catch {
      // Decode / parse failure — drop the broken half. Better an empty
      // half than a rendering exception that wipes the whole tile.
      return '';
    }
  });
}

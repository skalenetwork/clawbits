/**
 * SVG path generators for the collectible AgentCard's ornamental silhouettes.
 *
 * Everything here is pure geometry returning an SVG `d` string, kept separate
 * from the React layer so the shapes can be tuned (bump size, counts) and unit
 * reasoned about in isolation. All paths are authored in the card's local user
 * space (the same coordinate system as the `<svg viewBox>`), so they scale with
 * the card and never distort.
 *
 * The outer FRAME is the only ornamental shape; the gradient body that sits
 * inside it is a plain rounded rectangle (see `roundedRectPath`). That mirrors
 * the mockups, where the scalloped / perforated part is a white (or black)
 * "matte" framing an ordinary rounded card.
 */

/** Format a number to a compact path-coordinate string. */
const fmt = (n: number): string => n.toFixed(2);

/** Standard rounded-rectangle path (clockwise). */
export function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): string {
  const rr = Math.min(r, w / 2, h / 2);
  return [
    `M ${fmt(x + rr)} ${fmt(y)}`,
    `H ${fmt(x + w - rr)}`,
    `A ${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(x + w)} ${fmt(y + rr)}`,
    `V ${fmt(y + h - rr)}`,
    `A ${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(x + w - rr)} ${fmt(y + h)}`,
    `H ${fmt(x + rr)}`,
    `A ${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(x)} ${fmt(y + h - rr)}`,
    `V ${fmt(y + rr)}`,
    `A ${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(x + rr)} ${fmt(y)}`,
    "Z",
  ].join(" ");
}

/**
 * Scalloped "cloud / flower" frame: ONE continuous chain of equal outward
 * bumps walked around a rounded-rectangle perimeter — so the bumps flow around
 * the corners at the SAME size as the edges (no separately-overlaid corner
 * lobes, hence no seam / size-mismatch with the side pattern).
 *
 * The base rounded rect is inset by `inset` so the lobes bulge out toward the
 * bounding box (0,0,w,h). `lobe` sizes the bumps independently of `inset`, so a
 * shape can have big rounded lobes while keeping the valleys shallow (that keeps
 * a white margin around the body — see `wavePath`). We sample the perimeter at a
 * fixed arc-length step and draw a semicircle on each chord; chords that straddle
 * a corner come out slightly shorter, which reads as a natural corner scallop.
 */
function scallopChain(w: number, h: number, inset: number, lobe: number): string {
  const cr = lobe * 1.15; // base corner radius
  const x0 = inset;
  const y0 = inset;
  const x1 = w - inset;
  const y1 = h - inset;
  const sx = x1 - x0 - 2 * cr; // straight-run lengths
  const sy = y1 - y0 - 2 * cr;
  const arc = (Math.PI / 2) * cr; // quarter-corner arc length
  const q = Math.PI / 2;

  // Rounded-rect perimeter, clockwise, as arc-length-parameterized segments.
  const segs: { len: number; at: (t: number) => [number, number] }[] = [
    { len: sx, at: (t) => [x0 + cr + t * sx, y0] },
    { len: arc, at: (t) => { const a = -q + t * q; return [x1 - cr + cr * Math.cos(a), y0 + cr + cr * Math.sin(a)]; } },
    { len: sy, at: (t) => [x1, y0 + cr + t * sy] },
    { len: arc, at: (t) => { const a = t * q; return [x1 - cr + cr * Math.cos(a), y1 - cr + cr * Math.sin(a)]; } },
    { len: sx, at: (t) => [x1 - cr - t * sx, y1] },
    { len: arc, at: (t) => { const a = q + t * q; return [x0 + cr + cr * Math.cos(a), y1 - cr + cr * Math.sin(a)]; } },
    { len: sy, at: (t) => [x0, y1 - cr - t * sy] },
    { len: arc, at: (t) => { const a = Math.PI + t * q; return [x0 + cr + cr * Math.cos(a), y0 + cr + cr * Math.sin(a)]; } },
  ];
  const total = segs.reduce((s, seg) => s + seg.len, 0);
  const at = (dist: number): [number, number] => {
    let d = ((dist % total) + total) % total;
    for (const seg of segs) {
      if (d <= seg.len) return seg.at(seg.len === 0 ? 0 : d / seg.len);
      d -= seg.len;
    }
    return [x0 + cr, y0]; // perimeter start (unreachable in practice)
  };

  const n = Math.max(8, Math.round(total / (2 * lobe)));
  const step = total / n;
  const start = at(0);
  const d: string[] = [`M ${fmt(start[0])} ${fmt(start[1])}`];
  for (let i = 1; i <= n; i++) {
    const prev = at((i - 1) * step);
    const p = at(i * step);
    // Semicircle on the chord, bulging outward (clockwise ⇒ sweep-flag 1).
    const r = Math.hypot(p[0] - prev[0], p[1] - prev[1]) / 2;
    d.push(`A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(p[0])} ${fmt(p[1])}`);
  }
  d.push("Z");
  return d.join(" ");
}

/** scallop = valleys and lobes both keyed to `bump` (lobes reach the bounds). */
function scallopPath(w: number, h: number, bump: number): string {
  return scallopChain(w, h, bump, bump);
}

/**
 * Postage-stamp frame: a rectangle with small rounded outer corners and a row
 * of INWARD semicircular perforations along every edge. The straight runs sit
 * on the bounding box (0,0,w,h) and the notches dip toward the center, so the
 * outer extent is exactly w×h.
 */
function stampPath(w: number, h: number, notch: number): string {
  const c = notch * 0.85; // outer corner radius — a touch smaller than a notch
  const L = c;
  const T = c;
  const R = w - c;
  const B = h - c;
  const spanX = R - L;
  const spanY = B - T;
  const nx = Math.max(1, Math.round(spanX / (2 * notch)));
  const ny = Math.max(1, Math.round(spanY / (2 * notch)));
  const bx = spanX / (2 * nx);
  const by = spanY / (2 * ny);

  const d: string[] = [`M ${fmt(L)} 0`];
  // Top edge notches dip down (inward). Concave from outside ⇒ sweep-flag 0.
  for (let i = 1; i <= nx; i++) d.push(`A ${fmt(bx)} ${fmt(bx)} 0 0 0 ${fmt(L + i * 2 * bx)} 0`);
  // TR corner (convex, sweep 1).
  d.push(`A ${fmt(c)} ${fmt(c)} 0 0 1 ${fmt(w)} ${fmt(c)}`);
  // Right edge notches dip left (inward).
  for (let i = 1; i <= ny; i++) d.push(`A ${fmt(by)} ${fmt(by)} 0 0 0 ${fmt(w)} ${fmt(T + i * 2 * by)}`);
  // BR corner.
  d.push(`A ${fmt(c)} ${fmt(c)} 0 0 1 ${fmt(R)} ${fmt(h)}`);
  // Bottom edge notches dip up (inward).
  for (let i = 1; i <= nx; i++) d.push(`A ${fmt(bx)} ${fmt(bx)} 0 0 0 ${fmt(R - i * 2 * bx)} ${fmt(h)}`);
  // BL corner.
  d.push(`A ${fmt(c)} ${fmt(c)} 0 0 1 0 ${fmt(B)}`);
  // Left edge notches dip right (inward).
  for (let i = 1; i <= ny; i++) d.push(`A ${fmt(by)} ${fmt(by)} 0 0 0 0 ${fmt(B - i * 2 * by)}`);
  // TL corner.
  d.push(`A ${fmt(c)} ${fmt(c)} 0 0 1 ${fmt(L)} 0`);
  d.push("Z");
  return d.join(" ");
}

/** Chamfered (cut-corner) rectangle — an octagon-ish frame silhouette. */
function cutCornerRectPath(w: number, h: number, cut: number): string {
  return [
    `M ${fmt(cut)} 0`,
    `H ${fmt(w - cut)}`,
    `L ${fmt(w)} ${fmt(cut)}`,
    `V ${fmt(h - cut)}`,
    `L ${fmt(w - cut)} ${fmt(h)}`,
    `H ${fmt(cut)}`,
    `L 0 ${fmt(h - cut)}`,
    `V ${fmt(cut)}`,
    "Z",
  ].join(" ");
}

/**
 * "filmstrip" — a rounded card with a column of square sprocket notches punched
 * into the left and right edges, like a strip of film / a cinema-collectible
 * card. `notch` sizes the holes; `r` keeps the four corners rounded. The holes
 * are evenly spaced (with a half-gap at each end) between the corner radii.
 */
function filmstripPath(w: number, h: number, r: number, notch: number): string {
  const inset = notch * 0.9; // how deep each sprocket hole bites in
  const hh = notch * 1.15; // hole height
  const n = Math.max(4, Math.round((h - 2 * r - hh) / (notch * 2.3)));
  const gap = (h - 2 * r - n * hh) / (n + 1); // even spacing, incl. the ends
  const d: string[] = [
    `M ${fmt(r)} 0`,
    `H ${fmt(w - r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(w)} ${fmt(r)}`,
  ];
  // Right edge, top→bottom, dipping inward at each hole.
  let y = r;
  for (let i = 0; i < n; i++) {
    const y0 = y + gap;
    const y1 = y0 + hh;
    d.push(`V ${fmt(y0)}`, `H ${fmt(w - inset)}`, `V ${fmt(y1)}`, `H ${fmt(w)}`);
    y = y1;
  }
  d.push(
    `V ${fmt(h - r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(w - r)} ${fmt(h)}`,
    `H ${fmt(r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 0 ${fmt(h - r)}`,
  );
  // Left edge, bottom→top, dipping inward at each hole.
  y = h - r;
  for (let i = 0; i < n; i++) {
    const y0 = y - gap;
    const y1 = y0 - hh;
    d.push(`V ${fmt(y0)}`, `H ${fmt(inset)}`, `V ${fmt(y1)}`, `H 0`);
    y = y1;
  }
  d.push(`V ${fmt(r)}`, `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(r)} 0`, "Z");
  return d.join(" ");
}

/**
 * "tag" — a name-tag / label silhouette: the top two corners are chamfered
 * (angled cut) while the bottom two stay rounded. `cut` is the chamfer size,
 * `r` the bottom corner radius.
 */
function tagPath(w: number, h: number, cut: number, r: number): string {
  return [
    `M ${fmt(cut)} 0`,
    `H ${fmt(w - cut)}`,
    `L ${fmt(w)} ${fmt(cut)}`,
    `V ${fmt(h - r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(w - r)} ${fmt(h)}`,
    `H ${fmt(r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 0 ${fmt(h - r)}`,
    `V ${fmt(cut)}`,
    `L ${fmt(cut)} 0`,
    "Z",
  ].join(" ");
}

/**
 * "wave" — big rounded cloud lobes but a SHALLOW inset, so the valleys keep a
 * comfortable white margin around the body instead of biting into it. Decouples
 * lobe-size from inset via {@link scallopChain}.
 */
function wavePath(w: number, h: number, ornament: number): string {
  return scallopChain(w, h, ornament * 0.87, ornament * 1.4);
}

/** "ticket" — a rounded rectangle with a semicircular stub notch punched into the
 *  middle of the left and right edges. */
function ticketPath(w: number, h: number, r: number, nr: number): string {
  const my = h / 2;
  return [
    `M ${fmt(r)} 0`, `H ${fmt(w - r)}`, `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(w)} ${fmt(r)}`,
    `V ${fmt(my - nr)}`, `A ${fmt(nr)} ${fmt(nr)} 0 0 0 ${fmt(w)} ${fmt(my + nr)}`,
    `V ${fmt(h - r)}`, `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(w - r)} ${fmt(h)}`,
    `H ${fmt(r)}`, `A ${fmt(r)} ${fmt(r)} 0 0 1 0 ${fmt(h - r)}`,
    `V ${fmt(my + nr)}`, `A ${fmt(nr)} ${fmt(nr)} 0 0 0 0 ${fmt(my - nr)}`,
    `V ${fmt(r)}`, `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(r)} 0`, "Z",
  ].join(" ");
}

export type FrameShape =
  | "scallop" | "stamp" | "scallopDeep" | "bevel" | "soft"
  | "tag" | "filmstrip" | "wave" | "ticket";

/** Every frame silhouette. Selection is weighted — see {@link pickFrameShape}. */
export const FRAME_SHAPES: FrameShape[] = [
  "scallop", "stamp", "scallopDeep", "bevel", "soft", "tag", "filmstrip", "wave", "ticket",
];

/**
 * Selection weights: calmer silhouettes are more common and the bold ones rarer,
 * so a large roster leans gentle. (Uniform would over-represent the loud shapes,
 * since bold now outnumbers calm.)
 */
const FRAME_WEIGHTS: Record<FrameShape, number> = {
  soft: 5, tag: 4, scallop: 3, stamp: 3, bevel: 3, filmstrip: 2, scallopDeep: 2, wave: 2, ticket: 2,
};

/** Pick a frame shape from a single [0,1) random, honouring {@link FRAME_WEIGHTS}.
 *  One draw in, one shape out — so the caller's PRNG sequence stays stable. */
export function pickFrameShape(r: number): FrameShape {
  const total = FRAME_SHAPES.reduce((s, sh) => s + FRAME_WEIGHTS[sh], 0);
  let t = r * total;
  for (const sh of FRAME_SHAPES) {
    t -= FRAME_WEIGHTS[sh];
    if (t < 0) return sh;
  }
  return "soft";
}

/**
 * Dispatch to the right frame generator. Nine silhouettes so a large roster of
 * cards doesn't rhyme: two scallop densities, a postage-stamp, a chamfered
 * "bevel", a plain large-radius "soft" card, a chamfered-top "tag", a
 * sprocket-edged "filmstrip", a shallow-inset "wave", and a side-notched
 * "ticket". All in (0,0,w,h).
 */
export function framePath(
  shape: FrameShape,
  w: number,
  h: number,
  ornament: number,
): string {
  switch (shape) {
    case "stamp":
      return stampPath(w, h, ornament);
    case "scallopDeep":
      return scallopPath(w, h, ornament * 1.7);
    case "bevel":
      return cutCornerRectPath(w, h, ornament * 2.4);
    case "soft":
      return roundedRectPath(0, 0, w, h, ornament * 2.6);
    case "tag":
      return tagPath(w, h, ornament * 2.3, ornament * 1.85);
    case "filmstrip":
      return filmstripPath(w, h, ornament * 2.6, ornament * 1.25);
    case "wave":
      return wavePath(w, h, ornament);
    case "ticket":
      return ticketPath(w, h, ornament * 2.2, ornament * 1.5);
    case "scallop":
    default:
      return scallopPath(w, h, ornament);
  }
}

/**
 * A circular arc path used as a baseline for curved text (SVG `<textPath>`).
 * Returns an arc centered at (cx, cy) of the given radius, spanning `sweepDeg`
 * degrees centered on top-dead-center. Drawn left→right so text reads normally
 * with `text-anchor: middle` + `startOffset: 50%`. A gentle "rainbow" smile.
 */
export function arcTextPath(
  cx: number,
  cy: number,
  radius: number,
  sweepDeg: number,
): string {
  const half = (sweepDeg * Math.PI) / 180 / 2;
  // Start at the left end of the arc, end at the right end. Angle measured from
  // vertical (top). x = cx + r·sin θ, y = cy - r·cos θ.
  const x0 = cx - radius * Math.sin(half);
  const y0 = cy - radius * Math.cos(half);
  const x1 = cx + radius * Math.sin(half);
  const y1 = cy - radius * Math.cos(half);
  // Large-arc 0 (shallow), sweep 1 (curves up over the top).
  return `M ${fmt(x0)} ${fmt(y0)} A ${fmt(radius)} ${fmt(radius)} 0 0 1 ${fmt(x1)} ${fmt(y1)}`;
}

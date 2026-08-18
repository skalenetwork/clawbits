/**
 * Collectible-card geometry, ported 1:1 from the real card system
 * (frontend/src/components/agent-card/: AgentCollectibleCard.tsx, shapes.ts,
 * JoinedSeal.tsx, OperatorSeal.tsx).
 *
 * Card space is 360×568 with 48px headroom above (viewBox "0 -48 360 568") for
 * the JOINED medal; frame (12,14) 336×492; body (40,42) 280×436 r26; avatar
 * circle (180,238) r78 on a white r84 disc; name/handle arcs curve OVER the
 * medallion (r136/150° and r112/132°).
 *
 * EXTRACTED from AppDemo.astro (2026-08-18), which is where it was written and
 * which still renders the homepage's cards from it. The /agent-pit step visuals
 * draw the same card at a fraction of the size, and a second copy of these
 * numbers would have been a second card system: the two would agree until the
 * first time either was touched. Everything here is pure - no DOM, no Astro -
 * so it costs a component nothing to import.
 *
 * The card is ALL SVG, which is why the small versions can be faithful rather
 * than suggestive: a viewBox scales the whole construction, so a 120px card is
 * the same drawing as a 360px one with the text riding smaller. Only the copy
 * has a floor, which is why the miniatures drop the handle and the seals.
 */

export const fx = (n: number) => Math.round(n * 100) / 100;

/** Top arc, left→right over the apex (shapes.ts arcTextPath). */
export const arcText = (cx: number, cy: number, r: number, sweepDeg: number) => {
  const half = (sweepDeg * Math.PI) / 180 / 2;
  const x0 = fx(cx - r * Math.sin(half));
  const x1 = fx(cx + r * Math.sin(half));
  const y = fx(cy - r * Math.cos(half));
  return `M ${x0} ${y} A ${r} ${r} 0 0 1 ${x1} ${y}`;
};

/** Bottom arc, left→right under the center (OperatorSeal ringPath). */
export const bottomArc = (cx: number, cy: number, r: number) =>
  `M ${cx - r} ${cy} A ${r} ${r} 0 0 0 ${cx + r} ${cy}`;

/**
 * Scalloped stamp frame: rounded corners with outward lobes along each run - a
 * simplified take on shapes.ts scallopChain. Local w×h coords.
 */
export const scallopFrame = (w: number, h: number) => {
  const inset = 9;
  const cr = 20;
  const run = (len: number) => {
    const k = Math.max(1, Math.round(len / 26));
    return { k, s: fx(len / k), r: fx(len / k / 2) };
  };
  const tx = run(w - 2 * inset - 2 * cr);
  const ty = run(h - 2 * inset - 2 * cr);
  let d = `M ${inset + cr} ${inset}`;
  for (let i = 0; i < tx.k; i++) d += ` a ${tx.r} ${tx.r} 0 0 1 ${tx.s} 0`;
  d += ` a ${cr} ${cr} 0 0 1 ${cr} ${cr}`;
  for (let i = 0; i < ty.k; i++) d += ` a ${ty.r} ${ty.r} 0 0 1 0 ${ty.s}`;
  d += ` a ${cr} ${cr} 0 0 1 ${-cr} ${cr}`;
  for (let i = 0; i < tx.k; i++) d += ` a ${tx.r} ${tx.r} 0 0 1 ${-tx.s} 0`;
  d += ` a ${cr} ${cr} 0 0 1 ${-cr} ${-cr}`;
  for (let i = 0; i < ty.k; i++) d += ` a ${ty.r} ${ty.r} 0 0 1 0 ${-ty.s}`;
  d += ` a ${cr} ${cr} 0 0 1 ${cr} ${-cr} Z`;
  return d;
};

/** 12 registration ticks around the medallion (r88 → r95). */
export const TICKS = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  return {
    x1: fx(180 + Math.cos(a) * 88),
    y1: fx(238 + Math.sin(a) * 88),
    x2: fx(180 + Math.cos(a) * 95),
    y2: fx(238 + Math.sin(a) * 95),
  };
});

/** Liveness dot rides the avatar's lower-left diagonal: (r+2)/√2. */
export const PRES = {
  cx: fx(180 - 80 * Math.SQRT1_2),
  cy: fx(238 + 80 * Math.SQRT1_2),
};

/** PresenceDot palette (also the card's STATUS_COLOR). */
export const STATUS: Record<string, string> = {
  available: "#10b981",
  setup: "#3b82f6",
  offline: "#a1a1aa",
};

/**
 * Body textures, copied from the app's own CARD_PATTERNS
 * (frontend/src/components/agent-card/patterns.ts) - 48×48 tiles drawn in
 * `currentColor` so the card tints and fades them into the body.
 *
 * The app ships eleven and picks one per card by seed; the step visuals carry
 * two, which is enough for a row of three to read as a collection rather than
 * a repeat. Both are verbatim from that file - do not hand-edit the path data.
 *
 * `dots` is the tile AppDemo draws (two dots, two crosses). `plus` is index 7
 * of the app's set: a grid of plus signs, chosen because it stays legible at
 * the size these cards render and reads as obviously different from the dots
 * rather than as a slightly different smudge.
 */
const PLUS_TILE =
  "<g><g><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M24 -5H23V-1H19V0H23V4H24V0H28V-1H24V-5Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M24 43H23V47H19V48H23V52H24V48H28V47H24V43Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M0 19H-1V23H-5V24H-1V28H0V24H4V23H0V19Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M0 -5H-1V-1H-5V0H-1V4H0V0H4V-1H0V-5Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M48 19H47V23H43V24H47V28H48V24H52V23H48V19Z\" fill=\"currentColor\"></path></g></g><g><g><path d=\"M-1 -1L49 49\" stroke=\"currentColor\"></path><path d=\"M-25 23L25 73\" stroke=\"currentColor\"></path><path d=\"M22.5 -25.5L72.5 24.5\" stroke=\"currentColor\"></path><path d=\"M-25 -1L25 49\" stroke=\"currentColor\"></path><path d=\"M-1.5 -25.5L48.5 24.5\" stroke=\"currentColor\"></path><path d=\"M-13 -1L37 49\" stroke=\"currentColor\"></path><path d=\"M10.5 -25.5L60.5 24.5\" stroke=\"currentColor\"></path><path d=\"M-37 -1L13 49\" stroke=\"currentColor\"></path><path d=\"M-13.5 -25.5L54 42\" stroke=\"currentColor\"></path><path d=\"M-7 -1L43 49\" stroke=\"currentColor\"></path><path d=\"M-31 23L19 73\" stroke=\"currentColor\"></path><path d=\"M16.5 -25.5L66.5 24.5\" stroke=\"currentColor\"></path><path d=\"M-31 -1L19 49\" stroke=\"currentColor\"></path><path d=\"M-7.5 -25.5L49.5 31.5\" stroke=\"currentColor\"></path><path d=\"M-19 -1L31 49\" stroke=\"currentColor\"></path><path d=\"M4.5 -25.5L54.5 24.5\" stroke=\"currentColor\"></path><path d=\"M-43 -1L7 49\" stroke=\"currentColor\"></path><path d=\"M-19.5 -25.5L50 44\" stroke=\"currentColor\"></path><path d=\"M-1 -1L49 49\" stroke=\"currentColor\"></path><path d=\"M-25 23L25 73\" stroke=\"currentColor\"></path><path d=\"M22.5 -25.5L72.5 24.5\" stroke=\"currentColor\"></path><path d=\"M-25 -1L25 49\" stroke=\"currentColor\"></path><path d=\"M-1.5 -25.5L48.5 24.5\" stroke=\"currentColor\"></path><path d=\"M-13 -1L37 49\" stroke=\"currentColor\"></path><path d=\"M-37 23L13 73\" stroke=\"currentColor\"></path><path d=\"M10.5 -25.5L60.5 24.5\" stroke=\"currentColor\"></path><path d=\"M-37 -1L13 49\" stroke=\"currentColor\"></path><path d=\"M-13.5 -25.5L55 43\" stroke=\"currentColor\"></path></g></g><g><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M48 43V46H47V43H48Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M48 37V40H47V37H48Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M48 31V34H47V31H48Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M48 25V28H47V25H48Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M48 19V22H47V19H48Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M48 13V16H47V13H48Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M48 7V10H47V7H48Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M48 1V4H47V1H48Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M24 43V46H23V43H24Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M24 37V40H23V37H24Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M24 31V34H23V31H24Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M24 25V28H23V25H24Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M24 19V22H23V19H24Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M24 13V16H23V13H24Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M24 7V10H23V7H24Z\" fill=\"currentColor\"></path><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M24 1V4H23V1H24Z\" fill=\"currentColor\"></path></g><g><path d=\"M48 47.5001H0\" stroke=\"currentColor\"></path></g>";

export const CARD_PATTERN = {
  dots:
    '<circle cx="10" cy="10" r="1.6" fill="currentColor" />' +
    '<circle cx="34" cy="34" r="1.6" fill="currentColor" />' +
    '<path d="M32 10h8M36 6v8" stroke="currentColor" stroke-width="1.4" />' +
    '<path d="M8 36h6M11 33v6" stroke="currentColor" stroke-width="1.4" />',
  plus: PLUS_TILE,
} as const;

/** One agent's card, as the step visuals draw it. */
export interface MiniCard {
  name: string;
  /** File in /avatars. */
  av: string;
  from: string;
  to: string;
  angle: number;
  frame: "soft" | "scallop";
  pattern: keyof typeof CARD_PATTERN;
  status: keyof typeof STATUS;
}

/**
 * The collectible card as SVG markup, at whatever size the caller's box gives
 * it - the viewBox carries every proportion, which is what lets a 120px card
 * be the same drawing as a 360px one.
 *
 * A string builder rather than a component because three call sites need the
 * identical drawing and two of them are inside other template literals. It was
 * written twice before this - once per visual - and the two had already begun
 * to differ.
 *
 * `id` namespaces the defs. Gradients, clip paths and the arc are referenced by
 * id, and two cards on one page sharing an id would both take the first card's
 * gradient.
 *
 * Safe to inject: every value comes from the caller's own card data or from
 * this file, never from user input.
 *
 * What it deliberately omits, because copy has a floor that shapes do not: the
 * handle arc, the JOINED medal's date, the operator seal. All three fall below
 * a legible size at the scale these render and would read as smudges.
 */
export function miniCardSvg(a: MiniCard, id: string): string {
  const frame =
    a.frame === "scallop"
      ? `<path d="${scallopFrame(336, 492)}" transform="translate(12 14)" fill="#fff" />`
      : `<rect x="12" y="14" width="336" height="492" rx="39" fill="#fff" />`;

  return (
    `<svg class="csvg" viewBox="0 -48 360 568" aria-hidden="true">` +
    `<defs>` +
    `<linearGradient id="${id}-g" x1="0" y1="0" x2="0" y2="1" gradientTransform="rotate(${a.angle} 0.5 0.5)">` +
    `<stop offset="0%" stop-color="${a.from}" /><stop offset="100%" stop-color="${a.to}" />` +
    `</linearGradient>` +
    `<clipPath id="${id}-bc"><rect x="40" y="42" width="280" height="436" rx="26" /></clipPath>` +
    `<clipPath id="${id}-ac"><circle cx="180" cy="238" r="78" /></clipPath>` +
    `<path id="${id}-na" d="${arcText(180, 238, 136, 150)}" fill="none" />` +
    // The seeded body texture paints in currentColor, exactly as the real card
    // does, so `color` on the pattern is what tints it.
    `<pattern id="${id}-pt" width="48" height="48" patternUnits="userSpaceOnUse" color="#fff">` +
    CARD_PATTERN[a.pattern] +
    `</pattern>` +
    `</defs>` +
    frame +
    `<rect x="40" y="42" width="280" height="436" rx="26" fill="url(#${id}-g)" />` +
    `<g clip-path="url(#${id}-bc)" opacity="0.16">` +
    `<rect x="40" y="42" width="280" height="436" fill="url(#${id}-pt)" />` +
    `</g>` +
    // Radar rings and crosshair, body-clipped.
    `<g clip-path="url(#${id}-bc)" stroke="#fff" stroke-width="1" fill="none" opacity="0.11">` +
    `<circle cx="180" cy="260" r="52" /><circle cx="180" cy="260" r="100" />` +
    `<circle cx="180" cy="260" r="148" /><circle cx="180" cy="260" r="196" />` +
    `<line x1="180" y1="42" x2="180" y2="478" /><line x1="40" y1="260" x2="320" y2="260" />` +
    `</g>` +
    `<text font-size="34" font-weight="700" fill="#fff">` +
    `<textPath href="#${id}-na" startOffset="50%" text-anchor="middle">${a.name}</textPath>` +
    `</text>` +
    `<circle cx="180" cy="238" r="92" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="1.5" />` +
    `<g stroke="#fff" stroke-opacity="0.4" stroke-width="1.5">` +
    TICKS.map((t) => `<line x1="${t.x1}" y1="${t.y1}" x2="${t.x2}" y2="${t.y2}" />`).join("") +
    `</g>` +
    `<circle cx="180" cy="238" r="84" fill="#fff" />` +
    `<image href="/avatars/${a.av}" x="102" y="160" width="156" height="156" clip-path="url(#${id}-ac)" />` +
    `<circle cx="${PRES.cx}" cy="${PRES.cy}" r="15" fill="#fff" />` +
    `<circle cx="${PRES.cx}" cy="${PRES.cy}" r="10" fill="${STATUS[a.status]}" />` +
    `</svg>`
  );
}

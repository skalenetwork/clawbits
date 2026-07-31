/**
 * Visual themes for the collectible AgentCard.
 *
 * There is deliberately NO "rarity" concept — agents don't have rarity. Each
 * card gets a stable, good-looking palette generated deterministically from the
 * agent seed, so a given agent always looks the same everywhere.
 *
 * The palette is GENERATED (not picked from a small fixed list) so a large
 * roster of cards doesn't visibly rhyme: hue is spread by the golden angle (or
 * taken from the agent's avatar when available), the second stop follows a
 * seeded colour-harmony scheme, and the frame silhouette / gradient angle /
 * background pattern are each drawn independently. Gradients are kept GENTLE —
 * low chroma, so they read calm rather than neon — with white ink still legible
 * on the medium-lightness body. Everything is overridable via `themeOverrides`.
 */
import type { FrameShape } from "./shapes";
import { pickFrameShape } from "./shapes";
import { CARD_PATTERNS } from "./patterns";

export interface CardTheme {
  /** Frame ("matte") fill. */
  frame: string;
  /** Ornament silhouette. */
  shape: FrameShape;
  /** Body gradient stops. */
  gradientFrom: string;
  gradientTo: string;
  /** Body gradient direction in degrees (0 = top→bottom, + = clockwise). */
  gradientAngle: number;
  /** Ink for the name/handle text. */
  ink: string;
  /** Colour for the tiled background pattern (currentColor of the pattern). */
  pattern: string;
  /** Index into {@link CARD_PATTERNS} for the seeded background texture. */
  patternIndex: number;
  /** Tile scale for the background pattern. */
  patternScale: number;
  /** Deep, readable accent (the base hue) for text on the white seals. */
  accent: string;
}

/** FNV-1a hash (same family as lib/gradientFromSeed) for stable derivation. */
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Small deterministic PRNG seeded from a 32-bit int (Mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrapHue = (h: number): number => ((h % 360) + 360) % 360;
const oklch = (l: number, c: number, h: number): string =>
  `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${wrapHue(h).toFixed(1)})`;

/**
 * Deterministic, stable palette for an agent seed. Draws are made in a FIXED
 * order so the same seed renders identically everywhere, every session.
 *
 * @param avatarColor when set (sampled from the agent's avatar), the body hue is
 *   anchored to it AND the card chroma leans toward the avatar's own chroma — so
 *   a vivid avatar yields a more colourful card and a muted one a calmer card.
 *   Everything else stays seed-derived. Falls back to the golden-angle seed hue.
 */
export function cardThemeFromSeed(
  seed: string,
  avatarColor?: { h: number; c: number },
): CardTheme {
  const h = hash(`theme:${seed}`);
  const rnd = mulberry32(h);
  // Narrowed local so TS knows `av.h`/`av.c` are defined below.
  const av = avatarColor != null && Number.isFinite(avatarColor.h) ? avatarColor : null;

  // Base hue: the avatar's hue when we have it, else golden-angle-spread so a
  // roster stays maximally even.
  const baseHue = av ? wrapHue(av.h) : wrapHue(h * 137.508);

  // Second stop follows a seeded colour-harmony scheme (analogous most often).
  const schemePick = rnd();
  let offset: number;
  if (schemePick < 0.55) offset = 18 + rnd() * 18; // analogous (calmer bias)
  else if (schemePick < 0.78) offset = 150 + rnd() * 14; // split-complementary
  else if (schemePick < 0.9) offset = 180; // complementary
  else offset = rnd() < 0.5 ? 120 : 240; // triadic
  if (rnd() < 0.5) offset = -offset; // either direction round the wheel
  // Avatar-matched cards keep BOTH stops near the avatar hue (analogous), so the
  // card visibly reads as the agent's colour rather than a split palette.
  if (av) offset = offset >= 0 ? 24 : -24;
  const hue2 = wrapHue(baseHue + offset);

  // GENTLE: the big lever is LOW chroma (muted, not neon). Lightness stays in
  // the proven white-ink-legible mid band. When anchored to an avatar, lean the
  // chroma toward the avatar's own (clamped) so the match is actually visible.
  const lFrom = 0.65 + rnd() * 0.05; // 0.65–0.70
  const lTo = 0.55 + rnd() * 0.05; // 0.55–0.60
  let cFrom = 0.06 + rnd() * 0.04; // 0.06–0.10 (seed default)
  let cTo = 0.05 + rnd() * 0.035; // 0.05–0.085 (seed default)
  if (av) {
    const avC = Math.min(0.3, Math.max(0.04, av.c));
    cFrom = Math.min(0.14, Math.max(0.05, avC * 0.6));
    cTo = Math.max(0.045, cFrom * 0.82);
  }

  const gradientAngle = Math.round(rnd() * 70) * (rnd() < 0.5 ? 1 : -1); // −70…70
  const shape = pickFrameShape(rnd()); // weighted: calm shapes common, bold rare
  const patternIndex = CARD_PATTERNS.length > 0 ? Math.floor(rnd() * CARD_PATTERNS.length) : 0;
  const patternScale = 0.8 + rnd() * 0.7; // 0.8–1.5

  // Rare "premium" tier (~1/14): near-black matte + charcoal body — a little
  // punctuation across the roster. Skipped when a card is anchored to its
  // avatar's colour (a dark card would hide that colour).
  if (!av && rnd() < 1 / 14) {
    return {
      frame: "#0c0c0d",
      shape,
      gradientFrom: oklch(0.3, 0.025, baseHue),
      gradientTo: oklch(0.17, 0.02, hue2),
      gradientAngle,
      ink: "#ffffff",
      pattern: "#ffffff",
      patternIndex,
      patternScale,
      accent: oklch(0.4, 0.05, baseHue),
    };
  }

  return {
    frame: "#ffffff",
    shape,
    gradientFrom: oklch(lFrom, cFrom, baseHue),
    gradientTo: oklch(lTo, cTo, hue2),
    gradientAngle,
    ink: "#ffffff",
    pattern: "#ffffff",
    patternIndex,
    patternScale,
    accent: oklch(0.45, Math.min(0.16, cFrom + 0.07), baseHue),
  };
}

/** SVG linearGradient endpoints for a CSS-style angle in degrees (0 = up). */
export function gradientVector(
  angleDeg: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a) / 2;
  const dy = Math.cos(a) / 2;
  return { x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy };
}

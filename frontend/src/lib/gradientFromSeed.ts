/**
 * Deterministic seed → soft radial aura (see {@link auraFromSeed}). Same seed →
 * same aura forever, so an agent's backdrop doesn't shift between visits.
 */
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

/**
 * Soft radial aura keyed off the same seed — meant to sit behind a small
 * element (an avatar, a status dot) rather than wash a whole card. Centered
 * and tight; fades to transparent at the edge so neighbors stay clean.
 */
export function auraFromSeed(seed: string): string {
  const h = hash(seed);
  const hue = h % 360;
  return `radial-gradient(closest-side, oklch(0.74 0.14 ${String(hue)} / 0.45), oklch(0.74 0.14 ${String(hue)} / 0) 75%)`;
}

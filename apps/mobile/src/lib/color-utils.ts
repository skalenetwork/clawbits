/**
 * Tiny hex-color manipulation helpers for tile/icon styling.
 *
 * Operates on ``#RRGGBB`` strings. ``amount`` is in [0, 1] and represents a
 * fraction of the full channel range (0–255), so ``lighten('#808080', 0.2)``
 * adds 51 to each channel and ``darken('#808080', 0.2)`` subtracts 51.
 *
 * We work in sRGB rather than HSL because the UI gradient/border use is
 * "shift everything slightly lighter or darker", not "saturate-aware tint".
 * For richer palette work, swap to an HSL or OKLCH library — for now this
 * keeps zero deps and produces the right look for app-icon gloss.
 */

/** Brighten ``#RRGGBB`` by ``amount`` (each channel += amount * 255, clamped). */
export function lighten(hex: string, amount: number): string {
  const num = parseInt(hex.slice(1), 16);
  const delta = Math.round(255 * amount);
  const r = Math.min(255, ((num >> 16) & 0xff) + delta);
  const g = Math.min(255, ((num >> 8) & 0xff) + delta);
  const b = Math.min(255, (num & 0xff) + delta);
  return toHex(r, g, b);
}

/** Darken ``#RRGGBB`` by ``amount`` (each channel -= amount * 255, clamped). */
export function darken(hex: string, amount: number): string {
  const num = parseInt(hex.slice(1), 16);
  const delta = Math.round(255 * amount);
  const r = Math.max(0, ((num >> 16) & 0xff) - delta);
  const g = Math.max(0, ((num >> 8) & 0xff) - delta);
  const b = Math.max(0, (num & 0xff) - delta);
  return toHex(r, g, b);
}

/** Convert ``#RRGGBB`` to ``rgba(r, g, b, alpha)`` — used for transparent
 *  tints (translucent borders, soft overlays) where a solid hex would
 *  read too heavy. ``alpha`` is in [0, 1]. */
export function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Format ``#RRGGBB`` from three 0–255 channels. */
function toHex(r: number, g: number, b: number): string {
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

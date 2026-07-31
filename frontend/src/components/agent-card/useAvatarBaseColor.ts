/**
 * useAvatarBaseColor — samples an agent avatar image and returns its dominant
 * colour as `{ h, c }` (OKLCH hue 0–360 + a representative chroma) so the card
 * gradient can be anchored to the agent's own colour. Returns null when there's
 * no avatar, it's effectively greyscale, or the pixels can't be read
 * (cross-origin without CORS) — the card then falls back to its seed hue.
 *
 * Hue is a CHROMA-WEIGHTED circular mean (a few saturated pixels drive it);
 * chroma is the chroma-weighted mean chroma of those pixels, so a vivid avatar
 * yields a more colourful card and a muted one a calmer card.
 *
 * The sampler loads the image through a cache-busted URL with `crossOrigin`,
 * so it never reuses a NON-cors cache entry left by the card's plain <image>
 * (which would taint the canvas and silently kill the colour match). Results
 * are cached per source URL for the session.
 */
import { useEffect, useState } from "react";

export interface AvatarColor {
  /** OKLCH hue, degrees. */
  h: number;
  /** Representative OKLCH-ish chroma (0 ≈ grey, ~0.2+ ≈ vivid). */
  c: number;
}

const cache = new Map<string, AvatarColor | null>();

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** Linear sRGB → OKLab chroma + hue (degrees); lightness dropped. */
function chromaHue(r: number, g: number, b: number): { c: number; h: number } {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  return { c: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
}

/** Sample a loaded image → dominant {h,c}, or null if greyscale / unreadable. */
function dominantColor(img: HTMLImageElement): AvatarColor | null {
  const size = 28;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, size, size).data; // throws if tainted
  } catch {
    return null;
  }
  let sumSin = 0;
  let sumCos = 0;
  let weight = 0; // Σ c·α
  let cWeighted = 0; // Σ c²·α  → chroma-weighted mean chroma = cWeighted / weight
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] ?? 0;
    if (alpha < 24) continue; // skip transparent
    const r = srgbToLinear(data[i] ?? 0);
    const g = srgbToLinear(data[i + 1] ?? 0);
    const b = srgbToLinear(data[i + 2] ?? 0);
    const { c, h } = chromaHue(r, g, b);
    const w = c * (alpha / 255); // saturated pixels dominate
    const rad = (h * Math.PI) / 180;
    sumSin += w * Math.sin(rad);
    sumCos += w * Math.cos(rad);
    weight += w;
    cWeighted += c * w;
  }
  if (weight < 0.4) return null; // effectively greyscale → no colour signal
  const hue = ((((Math.atan2(sumSin, sumCos) * 180) / Math.PI) % 360) + 360) % 360;
  return { h: hue, c: cWeighted / weight };
}

/** Cache-busted, CORS-enabled URL for the sampler (distinct from the display
 *  <image> load, so the two don't share a possibly-tainted cache entry). */
function samplerUrl(url: string): string {
  return url + (url.includes("?") ? "&" : "?") + "_avpal=1";
}

export function useAvatarBaseColor(url: string | null | undefined): AvatarColor | null {
  const key = url ?? "";
  const initial = (k: string): AvatarColor | null => (k && cache.has(k) ? (cache.get(k) ?? null) : null);
  const [state, setState] = useState<{ url: string; color: AvatarColor | null }>(() => ({
    url: key,
    color: initial(key),
  }));
  // Adjust state when the url changes (render-phase, no effect) — reads any
  // cached colour synchronously so a revisited avatar paints instantly.
  if (state.url !== key) setState({ url: key, color: initial(key) });

  // The effect only sets up the async decode; setState happens in the image
  // callbacks (allowed), never synchronously in the effect body.
  useEffect(() => {
    if (!key || cache.has(key)) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    const finish = (color: AvatarColor | null) => {
      cache.set(key, color);
      if (!cancelled) setState((s) => (s.url === key ? { url: key, color } : s));
    };
    img.onload = () => { finish(dominantColor(img)); };
    img.onerror = () => { finish(null); };
    img.src = samplerUrl(key);
    return () => { cancelled = true; };
  }, [key]);

  return state.color;
}

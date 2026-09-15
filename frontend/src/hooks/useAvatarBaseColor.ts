import { useEffect, useState } from "react";

const cache = new Map<string, number | null>();

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function chromaHue(r: number, g: number, b: number): { c: number; h: number } {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { c: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
}

function dominantHue(img: HTMLImageElement): number | null {
  const size = 28;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null;
  }
  let sumSin = 0;
  let sumCos = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] ?? 0;
    if (alpha < 24) continue;
    const { c, h } = chromaHue(srgbToLinear(data[i] ?? 0), srgbToLinear(data[i + 1] ?? 0), srgbToLinear(data[i + 2] ?? 0));
    const w = c * (alpha / 255);
    const rad = (h * Math.PI) / 180;
    sumSin += w * Math.sin(rad);
    sumCos += w * Math.cos(rad);
    weight += w;
  }
  if (weight < 0.4) return null;
  return ((((Math.atan2(sumSin, sumCos) * 180) / Math.PI) % 360) + 360) % 360;
}

/** The avatar's chroma-weighted OKLCH hue in degrees, or null when there is no avatar, it is greyscale, or its
 *  pixels are unreadable. Samples a cache-busted CORS load so a non-CORS cache entry never taints the canvas. */
export function useAvatarBaseColor(url: string | null | undefined): number | null {
  const key = url ?? "";
  const [state, setState] = useState(() => ({ url: key, hue: cache.get(key) ?? null }));
  if (state.url !== key) setState({ url: key, hue: cache.get(key) ?? null });

  useEffect(() => {
    if (!key || cache.has(key)) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    const finish = (hue: number | null) => {
      cache.set(key, hue);
      if (!cancelled) setState((s) => (s.url === key ? { url: key, hue } : s));
    };
    img.onload = () => { finish(dominantHue(img)); };
    img.onerror = () => { finish(null); };
    img.src = `${key}${key.includes("?") ? "&" : "?"}_avpal=1`;
    return () => { cancelled = true; };
  }, [key]);

  return state.hue;
}

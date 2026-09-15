import { useEffect, useState } from "react";

const cache = new Map<string, GlassAvatarLayers>();
const IMAGE_RE = /<image\b[^>]*\/?>/gi;
const ICON_RE =
  /<g transform="translate\([^"]*\) scale\([^"]*\)" fill="none" stroke="[^"]+" stroke-width="2"[\s\S]*?<\/g>\s*(?=<\/svg>)/;

export const GLASS_BLUR_RADIUS = 52;
export const GLASS_BLUR_PAD = 120;
export const GLASS_LIGHTEN = 0.22;

export type GlassAvatarLayers = {
  bg: string;
  baseUri: string;
  iconUri?: string;
};

export function lightenHex(hex: string, amount = GLASS_LIGHTEN): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6) return hex;
  const mix = (pair: string) =>
    Math.round(parseInt(pair, 16) + (255 - parseInt(pair, 16)) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(h.slice(0, 2))}${mix(h.slice(2, 4))}${mix(h.slice(4, 6))}`;
}

export function lightenGlassFills(svg: string): string {
  return svg.replace(
    /fill="(#[0-9a-fA-F]{3,8})"/g,
    (_, hex: string) => `fill="${lightenHex(hex)}"`,
  );
}

export function extractBgColor(svg: string): string {
  for (const match of svg.matchAll(/<rect\b([^>]*)\/?>/g)) {
    const attrs = match[1];
    if (!/width="100"/.test(attrs) || !/height="100"/.test(attrs)) continue;
    const fill = attrs.match(/fill="(#[0-9a-fA-F]{3,8})"/)?.[1];
    if (fill) return fill;
  }
  return "#888888";
}

export function sanitizeGlassSvg(svg: string): string {
  return svg
    .replace(/<filter\b[^>]*>[\s\S]*?<\/filter>/gi, "")
    .replace(/\sfilter="url\([^"]*\)"/g, "")
    .replace(/\sstyle="mix-blend-mode:[^"]*"/g, "")
    .replace(/opacity="\.6"/g, 'opacity=".85"');
}

export function flattenGlassSvg(svg: string): string {
  const sanitized = sanitizeGlassSvg(svg);
  const images = sanitized.match(IMAGE_RE) ?? [];
  if (images.length === 0) return sanitized;

  const groups: string[] = [];
  for (const [i, tag] of images.entries()) {
    const href = tag.match(
      /(?:xlink:href|href)="data:image\/svg\+xml;base64,([^"]+)"/i,
    );
    if (!href) continue;
    const clip = tag.match(/clip-path="url\(#([^)]+)\)"/i)?.[1];
    const inner = rewriteIds(sanitizeGlassSvg(decodeSvgBase64(href[1])), `g${i}-`);
    const clipAttr = clip ? ` clip-path="url(#${clip})"` : "";
    groups.push(`<g${clipAttr}>${unwrapSvg(inner)}</g>`);
  }
  if (groups.length === 0) return sanitized;
  const withoutImages = sanitized.replace(IMAGE_RE, "");
  if (!withoutImages.includes("</svg>")) return withoutImages + groups.join("");
  return withoutImages.replace("</svg>", `${groups.join("")}</svg>`);
}

export function padGlassSvg(svg: string, bg: string): string {
  const size = 100 + GLASS_BLUR_PAD * 2;
  const viewBox = `viewBox="-${GLASS_BLUR_PAD} -${GLASS_BLUR_PAD} ${size} ${size}"`;
  const padded = svg.replace(/viewBox=["']0 0 100 100["']/, viewBox);
  const bleed = `<rect x="-${GLASS_BLUR_PAD}" y="-${GLASS_BLUR_PAD}" width="${size}" height="${size}" fill="${bg}"/>`;
  return padded.replace(/<svg\b[^>]*>/, (open) => `${open}${bleed}`);
}

export function splitGlassSvg(svg: string): {
  bg: string;
  base: string;
  icon: string | null;
} {
  const bg = lightenHex(extractBgColor(svg));
  const iconMatch = svg.match(ICON_RE);
  let base = svg;
  let icon: string | null = null;
  if (iconMatch) {
    icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${iconMatch[0]}</svg>`;
    base = svg.replace(iconMatch[0], "");
  }
  return {
    bg,
    base: padGlassSvg(lightenGlassFills(sanitizeGlassSvg(base)), bg),
    icon,
  };
}

export function prepareGlassAvatar(svg: string): GlassAvatarLayers {
  IMAGE_RE.lastIndex = 0;
  if (IMAGE_RE.test(svg)) {
    IMAGE_RE.lastIndex = 0;
    const flat = lightenGlassFills(flattenGlassSvg(svg));
    const bg = extractBgColor(flat);
    return { bg, baseUri: dataUri(padGlassSvg(flat, bg)) };
  }
  const { bg, base, icon } = splitGlassSvg(svg);
  return {
    bg,
    baseUri: dataUri(base),
    iconUri: icon ? dataUri(icon) : undefined,
  };
}

export function useGlassAvatar(
  url: string | undefined,
  enabled: boolean,
): GlassAvatarLayers | undefined {
  const [layers, setLayers] = useState<GlassAvatarLayers | undefined>(() =>
    url && enabled ? cache.get(url) : undefined,
  );
  useEffect(() => {
    if (!enabled || !url) {
      setLayers(undefined);
      return;
    }
    const hit = cache.get(url);
    if (hit) {
      setLayers(hit);
      return;
    }
    let live = true;
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.text();
      })
      .then((svg) => {
        const next = prepareGlassAvatar(svg);
        cache.set(url, next);
        if (live) setLayers(next);
      })
      .catch(() => {
        if (live) setLayers(undefined);
      });
    return () => {
      live = false;
    };
  }, [url, enabled]);
  return layers;
}

function dataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function unwrapSvg(svg: string): string {
  const open = svg.indexOf(">");
  const close = svg.lastIndexOf("</svg>");
  if (open === -1 || close === -1 || close < open) return svg;
  return svg.slice(open + 1, close);
}

function rewriteIds(svg: string, prefix: string): string {
  const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  let out = svg;
  for (const id of ids) {
    const safe = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`id="${safe}"`, "g"), `id="${prefix}${id}"`);
    out = out.replace(new RegExp(`url\\(#${safe}\\)`, "g"), `url(#${prefix}${id})`);
    out = out.replace(new RegExp(`href="#${safe}"`, "g"), `href="#${prefix}${id}"`);
    out = out.replace(
      new RegExp(`xlink:href="#${safe}"`, "g"),
      `xlink:href="#${prefix}${id}"`,
    );
  }
  return out;
}

function decodeSvgBase64(b64: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(b64, "base64").toString("utf8");
  }
  return atob(b64);
}

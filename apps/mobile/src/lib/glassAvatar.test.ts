import { describe, expect, test } from "bun:test";
import {
  extractBgColor,
  flattenGlassSvg,
  GLASS_BLUR_PAD,
  lightenHex,
  padGlassSvg,
  prepareGlassAvatar,
  sanitizeGlassSvg,
  splitGlassSvg,
} from "./glassAvatar";

const glass = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs>
<filter id="dicebearGlass-a" x="-57" y="-56.4" width="214" height="213.4">
<feFlood flood-opacity="0" result="r0"/>
<feGaussianBlur stdDeviation="16" result="r2"/>
</filter>
</defs>
<rect width="100" height="100" fill="#eb6247"/>
<g style="mix-blend-mode:screen" opacity=".6" filter="url(#dicebearGlass-a)">
<path d="M10 10h20v20H10z" fill="white"/>
</g>
</svg>`;

const channel = glass.replace(
  "</svg>",
  `<g transform="translate(29.000 29.000) scale(1.7500)" fill="none" stroke="#3a0a00" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8H21"/></g></svg>`,
);

describe("lightenHex", () => {
  test("mixes toward white without clipping", () => {
    expect(lightenHex("#000000", 0.2)).toBe("#333333");
    expect(lightenHex("#eb6247")).not.toBe("#eb6247");
    expect(lightenHex("#ffffff")).toBe("#ffffff");
  });
});

describe("extractBgColor", () => {
  test("reads fill even when width/height come first and a clip rect precedes it", () => {
    const svg = `<svg>
<defs><clipPath id="c"><rect width="100" height="100" rx="0"/></clipPath></defs>
<rect width="100" height="100" fill="#eb6247"/>
</svg>`;
    expect(extractBgColor(svg)).toBe("#eb6247");
  });
});

describe("sanitizeGlassSvg", () => {
  test("drops gaussian blur filters and mix-blend so SVGKit can paint the rest", () => {
    const out = sanitizeGlassSvg(glass);
    expect(out).not.toContain("feGaussianBlur");
    expect(out).not.toContain("<filter");
    expect(out).not.toContain("mix-blend-mode");
    expect(out).not.toContain('filter="url(#dicebearGlass-a)"');
    expect(out).toContain('fill="#eb6247"');
    expect(out).toContain('opacity=".85"');
    expect(out).toContain('fill="white"');
  });
});

describe("flattenGlassSvg", () => {
  test("inlines nested data-URI halves used by stitched human glass", () => {
    const top = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#111111" width="100" height="100"/></svg>',
    ).toString("base64");
    const bot = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#eeeeee" width="100" height="100"/></svg>',
    ).toString("base64");
    const stitched = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs>
<clipPath id="t"><rect x="0" y="0" width="100" height="50"/></clipPath>
<clipPath id="b"><rect x="0" y="50" width="100" height="50"/></clipPath>
</defs>
<image href="data:image/svg+xml;base64,${top}" clip-path="url(#t)"/>
<image href="data:image/svg+xml;base64,${bot}" clip-path="url(#b)"/>
</svg>`;
    const out = flattenGlassSvg(stitched);
    expect(out).not.toContain("<image");
    expect(out).toContain('clip-path="url(#t)"');
    expect(out).toContain('clip-path="url(#b)"');
    expect(out).toContain('fill="#111111"');
    expect(out).toContain('fill="#eeeeee"');
  });

  test("prefixes inner ids so stitched halves do not collide", () => {
    const half = Buffer.from(
      '<svg><defs><g id="shape"><path d="M0 0h1"/></g></defs><use href="#shape"/></svg>',
    ).toString("base64");
    const stitched = `<svg>
<image href="data:image/svg+xml;base64,${half}"/>
<image href="data:image/svg+xml;base64,${half}"/>
</svg>`;
    const out = flattenGlassSvg(stitched);
    expect(out).toContain('id="g0-shape"');
    expect(out).toContain('id="g1-shape"');
    expect(out).toContain('href="#g0-shape"');
    expect(out).toContain('href="#g1-shape"');
  });
});

describe("splitGlassSvg", () => {
  test("keeps channel hash sharp and pads glass for blur", () => {
    const { bg, base, icon } = splitGlassSvg(channel);
    const tint = lightenHex("#eb6247");
    expect(bg).toBe(tint);
    expect(icon).toContain('stroke="#3a0a00"');
    expect(icon).toContain('d="M5 8H21"');
    expect(base).not.toContain("M5 8H21");
    expect(base).not.toContain("feGaussianBlur");
    expect(base).toContain(`viewBox="-${GLASS_BLUR_PAD} -${GLASS_BLUR_PAD} ${100 + GLASS_BLUR_PAD * 2} ${100 + GLASS_BLUR_PAD * 2}"`);
    expect(base).toContain(`fill="${tint}"`);
    expect(base).toContain('fill="white"');
  });
});

describe("padGlassSvg", () => {
  test("extends viewBox so native blur does not sample empty edges", () => {
    const out = padGlassSvg(
      '<svg viewBox="0 0 100 100"><rect fill="#abcabc" width="100" height="100"/></svg>',
      "#abcabc",
    );
    expect(out).toContain(
      `viewBox="-${GLASS_BLUR_PAD} -${GLASS_BLUR_PAD} ${100 + GLASS_BLUR_PAD * 2} ${100 + GLASS_BLUR_PAD * 2}"`,
    );
    expect(out).toContain(
      `x="-${GLASS_BLUR_PAD}" y="-${GLASS_BLUR_PAD}" width="${100 + GLASS_BLUR_PAD * 2}" height="${100 + GLASS_BLUR_PAD * 2}" fill="#abcabc"`,
    );
  });
});

describe("prepareGlassAvatar", () => {
  test("channel avatar gets a blurred base layer and a separate icon uri", () => {
    const layers = prepareGlassAvatar(channel);
    expect(layers.bg).toBe(lightenHex("#eb6247"));
    expect(layers.iconUri).toBeDefined();
    const icon = decodeURIComponent(
      layers.iconUri!.slice("data:image/svg+xml;charset=utf-8,".length),
    );
    expect(icon).toContain("M5 8H21");
    const base = decodeURIComponent(
      layers.baseUri.slice("data:image/svg+xml;charset=utf-8,".length),
    );
    expect(base).not.toContain("M5 8H21");
    expect(base).toContain(
      `viewBox="-${GLASS_BLUR_PAD} -${GLASS_BLUR_PAD} ${100 + GLASS_BLUR_PAD * 2} ${100 + GLASS_BLUR_PAD * 2}"`,
    );
  });
});

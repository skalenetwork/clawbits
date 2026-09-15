/**
 * Bakes the canvas gradient to the images phones show (see SombraGradient.astro).
 * Renders the same SVG in the installed Chrome at 2x, at the live 85% over its
 * canvas ground, and encodes an opaque AVIF: with alpha the grain lands in the
 * alpha plane and the file triples. Re-run after touching src/lib/sombra.ts:
 *
 *   bun run sombra
 *
 * Sizes are the oversized .sombra box of the two canvases each shape covers:
 * the homepage hero (tall) and the homepage CTA (wide).
 */

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { PALETTES, sombraSvg, type Palette } from "../src/lib/sombra";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../public/sombra/", import.meta.url).pathname;
const SHAPES = { tall: [400, 840], wide: [360, 344] } as const;

mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();

for (const palette of Object.keys(PALETTES) as Palette[]) {
  for (const [shape, [width, height]] of Object.entries(SHAPES)) {
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.setContent(
      `<body style="margin:0;background:${PALETTES[palette].ground}"><div style="width:${width}px;height:${height}px;opacity:.85">${sombraSvg(palette, "bake")}</div></body>`,
    );
    const png = await page.screenshot({ type: "png" });
    const file = `${OUT}${palette}-${shape}.avif`;
    const { size } = await sharp(png).avif({ quality: 50, effort: 9 }).toFile(file);
    console.log(`${file} ${(size / 1024).toFixed(1)} KB`);
  }
}

await browser.close();

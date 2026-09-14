import { readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";

const W = 1200;
const H = 630;
const PAPER = "#f7f5f1";
const LOGO_H = 72;

const dataUri = (file: string, mime: string) =>
  `data:${mime};base64,${readFileSync(file).toString("base64")}`;

const base = dataUri("src/assets/og-base.png", "image/png");
const logo = dataUri("public/brand/clawbits-long-inverted.svg", "image/svg+xml");
const geist = readFileSync("node_modules/@fontsource/geist/files/geist-latin-300-normal.woff");

const el = (type: string, style: Record<string, string | number>, children?: unknown, src?: string) => ({
  type,
  props: { style, children, src, width: style.width, height: style.height },
});

export async function renderOg(title?: string): Promise<Buffer> {
  const lockup = el("img", { width: (LOGO_H * 4082) / 672, height: LOGO_H }, undefined, logo);
  const row = title
    ? [
        lockup,
        el("div", { width: 3, height: LOGO_H * 1.1, background: PAPER, margin: "0 40px" }),
        el("div", { fontSize: 92, lineHeight: 1, letterSpacing: "-0.02em", color: PAPER }, title),
      ]
    : [lockup];

  const svg = await satori(
    el(
      "div",
      { width: W, height: H, display: "flex", alignItems: "center", justifyContent: "center",backgroundImage: `url(${base})`, backgroundSize: `${W}px ${H}px` },
      row,
    ) as never,
    { width: W, height: H, fonts: [{ name: "Geist", data: geist, weight: 300, style: "normal" }] },
  );
  return new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng();
}

// Rasterizes icons-src/clawbits.png (a 1024px edge-to-edge Icon Composer export) onto Apple's 824px icon grid and
// runs `tauri icon` for the .icns, .ico and PNG fallbacks beside clawbits.icon. Commit the output.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";

const CANVAS = 1024;
const BODY = 824;
const inset = (CANVAS - BODY) / 2;

const root = resolve(import.meta.dirname, "..");
const icons = join(root, "src-tauri", "icons");
const work = mkdtempSync(join(tmpdir(), "clawbits-icons-"));
const gridded = join(work, "icon.png");

await sharp(join(root, "icons-src", "clawbits.png"))
  .resize(BODY, BODY)
  .extend({ top: inset, bottom: inset, left: inset, right: inset, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(gridded);

execFileSync("bunx", ["tauri", "icon", gridded, "--output", icons], { cwd: root, stdio: "inherit" });

for (const name of readdirSync(icons)) {
  if (name === "android" || name === "ios" || name.endsWith("Logo.png")) {
    rmSync(join(icons, name), { recursive: true });
  }
}
rmSync(work, { recursive: true });

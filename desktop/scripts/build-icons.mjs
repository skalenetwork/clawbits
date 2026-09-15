// Rasterizes icons-src/clawbits.png (a 1024px edge-to-edge Icon Composer export) onto Apple's 824px icon grid and
// runs `tauri icon` for the .icns, .ico and PNG fallbacks, then compiles clawbits.icon into Assets.car with the
// local Xcode (27+), exactly as tauri-bundler would. The bundle ships the pre-built Assets.car because GitHub's
// macOS runners still top out at Xcode 26.6, whose actool fails on this icon; point bundle.icon back at
// clawbits.icon once they ship Xcode 27. Commit the output.

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

const catalog = join(work, "catalog");
mkdirSync(catalog);
cpSync(join(icons, "clawbits.icon"), join(work, "Icon.icon"), { recursive: true });
execFileSync(
  "xcrun",
  [
    "actool",
    join(work, "Icon.icon"),
    "--compile",
    catalog,
    "--output-format",
    "human-readable-text",
    "--notices",
    "--warnings",
    "--output-partial-info-plist",
    join(catalog, "assetcatalog_generated_info.plist"),
    "--app-icon",
    "Icon",
    "--include-all-app-icons",
    "--accent-color",
    "AccentColor",
    "--enable-on-demand-resources",
    "NO",
    "--development-region",
    "en",
    "--target-device",
    "mac",
    "--minimum-deployment-target",
    "26.0",
    "--platform",
    "macosx",
  ],
  { stdio: "inherit" },
);
copyFileSync(join(catalog, "Assets.car"), join(icons, "Assets.car"));
rmSync(work, { recursive: true });

// Generate the Tauri icon bundle for a given channel.
//
// Sources at `desktop/icons-src/{dev,staging,prod}.png` are 1024×1024 raw
// exports from Icon Composer (edge-to-edge artwork). Using them directly
// makes the resulting app icon look oversized in the macOS dock; using
// Apple's stock 824/1024 ratio makes it look smaller than typical
// third-party apps in practice (the visible shadow/glow most apps bake
// into their artwork extends the perceived size past their solid body).
// 920/1024 ≈ 89.8% lands close to that perceived size, then we hand it to
// `tauri icon` which generates every derivative format.
//
// Channel resolution: positional arg → CLAWBITS_CHANNEL env → "dev".
// The shared monochrome `tray-icon.png` is preserved across regeneration.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const VALID_CHANNELS = ["dev", "staging", "prod"];
const channel = process.argv[2] || process.env.CLAWBITS_CHANNEL || "dev";
if (!VALID_CHANNELS.includes(channel)) {
  console.error(
    `[icons] unknown channel "${channel}"; expected one of ${VALID_CHANNELS.join(", ")}`,
  );
  process.exit(1);
}

const src = join(root, "icons-src", `${channel}.png`);
if (!existsSync(src)) {
  console.error(`[icons] missing source: ${src}`);
  process.exit(1);
}

const CANVAS = 1024;
const ART = 920;
const PAD = (CANVAS - ART) / 2;

const iconsDir = join(root, "src-tauri", "icons");
const tmpDir = join(root, "src-tauri", ".icons-tmp");
mkdirSync(tmpDir, { recursive: true });
const padded = join(tmpDir, `${channel}-padded.png`);

console.log(
  `[icons] channel=${channel} → padding to ${ART}px art centered in ${CANVAS}×${CANVAS}`,
);

await sharp(src)
  .resize(ART, ART, { kernel: sharp.kernel.lanczos3, fit: "contain" })
  .extend({
    top: PAD,
    bottom: PAD,
    left: PAD,
    right: PAD,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toFile(padded);

// `tauri icon` overwrites managed files but leaves anything it doesn't
// produce alone. Back up tray-icon.png defensively in case that ever
// changes — losing it silently would break the menubar UI.
const trayPath = join(iconsDir, "tray-icon.png");
const trayBak = join(tmpDir, "tray-icon.png");
if (existsSync(trayPath)) copyFileSync(trayPath, trayBak);

// Two passes: the first generates the default set (.icns, .ico, 32/64/128
// PNGs, mobile sizes, Microsoft Store logos); the second adds 512x512 for
// HiDPI Linux dock rendering — Tauri's `--png` flag REPLACES the default
// set instead of extending it, so we can't fold both into one call.
console.log(`[icons] running \`tauri icon\` (default sizes)`);
execFileSync(
  "npx",
  ["--no-install", "tauri", "icon", padded, "--output", iconsDir],
  { cwd: root, stdio: "inherit" },
);

console.log(`[icons] running \`tauri icon\` (HiDPI 512)`);
execFileSync(
  "npx",
  [
    "--no-install",
    "tauri",
    "icon",
    padded,
    "--output",
    iconsDir,
    "--png",
    "512",
  ],
  { cwd: root, stdio: "inherit" },
);

if (existsSync(trayBak) && !existsSync(trayPath)) {
  copyFileSync(trayBak, trayPath);
}

rmSync(tmpDir, { recursive: true, force: true });

console.log(`[icons] done.`);

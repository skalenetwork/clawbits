#!/usr/bin/env node
/**
 * Renders a landing-page visual to a video master, frame by exact frame.
 *
 * The animated cards on the home page (MailboxVisual, LobstertalkVisual and
 * the rest) are pure CSS loops, which means they do not have to be *recorded*
 * in real time - they can be STEPPED. This drives headless Chrome, pauses
 * every animation on the card, walks `currentTime` in fixed increments and
 * screenshots each position. So the output has no dropped frames, no timing
 * jitter, no cursor, and no dependence on how loaded the machine was.
 *
 * That is the whole reason this exists instead of pointing Screen Studio at
 * the page: a 15s loop captured at 30fps is exactly 450 frames, every time.
 *
 * It uses the Chrome already installed at /Applications, via puppeteer-core -
 * no 150 MB browser download.
 *
 * OUTPUT is a near-lossless master .mov. Feed that to make-demo.mjs to get the
 * shipping mp4/webm/gif:
 *
 *   node scripts/record-visual.mjs mailbox --url http://localhost:4321/
 *   node scripts/make-demo.mjs <master> --name mailbox --gif-frame --out social
 *
 * SCALE, not size. The cards are laid out by the page, so the way to get a
 * crisp asset is deviceScaleFactor (--scale), which renders the same layout at
 * N times the pixel density. Overriding the element's width instead would
 * re-flow the card and change the composition.
 *
 * Options:
 *   --url <url>      page to load        (default http://localhost:4321/)
 *   --fps <n>        capture rate        (default 30)
 *   --seconds <n>    loop length         (default: the preset's)
 *   --target-width   output width goal   (default 1200; sets scale per visual)
 *   --scale <n>      force deviceScaleFactor instead
 *   --selector <css> override the preset's selector
 *   --viewport <px>  layout width        (default 1440)
 *   --out <dir>      master destination  (default web/demo-exports)
 *   --keep-frames    leave the PNG sequence on disk
 */

import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Selector + loop length for each card. Durations are the longest `animation`
 * on the component - one full cycle, so the capture ends where it began and
 * the loop is seamless. Re-check if a component's timing changes. */
const PRESETS = {
  lobstertalk: { selector: ".lbox", seconds: 22 },
  // NOT seamless: ReefVisual mixes 1.4/9/10/14/16s loops, whose common period
  // is minutes long. 16s covers the slowest beat; expect a cut at the wrap.
  reef: { selector: ".panel", seconds: 16 },
  mailbox: { selector: ".mbox", seconds: 15 },
  git: { selector: ".gbox", seconds: 15 },
  automation: { selector: ".abox", seconds: 15 },
  agency: { selector: ".cbox", seconds: 15 },
  interagent: { selector: ".iabox", seconds: 20 },
  introchat: { selector: ".ichat", seconds: 13 },
};

const argv = process.argv.slice(2);
const name = argv.find((a) => !a.startsWith("--"));
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(`--${n}`);

if (!name || (!PRESETS[name] && !flag("selector", null))) {
  console.error(
    `\n  usage: node scripts/record-visual.mjs <${Object.keys(PRESETS).join("|")}>\n` +
      `         [--url http://localhost:4321/] [--fps 30] [--scale 3] [--seconds n]\n` +
      `         [--selector .css] [--viewport 1440] [--out dir] [--keep-frames]\n`,
  );
  process.exit(1);
}

const preset = PRESETS[name] ?? {};
const selector = String(flag("selector", preset.selector));
const seconds = Number(flag("seconds", preset.seconds ?? 15));
const fps = Number(flag("fps", 30));
// The cards range from 240 to 1030 CSS px wide, so a single scale would make
// some assets tiny and others enormous. Default is a TARGET WIDTH and the
// scale is derived per visual; --scale still wins if given explicitly.
const targetWidth = Number(flag("target-width", 1200));
const explicitScale = flag("scale", null);
const viewport = Number(flag("viewport", 1440));
const url = String(flag("url", "http://localhost:4321/"));
const outDir = join(WEB, String(flag("out", "demo-exports")));
const frameDir = join(outDir, `.frames-${name}`);
const master = join(outDir, `${name}-master.mov`);

if (!existsSync(CHROME)) {
  console.error(`\n  Google Chrome not found at ${CHROME}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
rmSync(frameDir, { recursive: true, force: true });
mkdirSync(frameDir, { recursive: true });

const total = Math.round(seconds * fps);
console.log(`\n  ${name}  ${selector}  ${seconds}s @ ${fps}fps = ${total} frames\n`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--force-color-profile=srgb", "--hide-scrollbars", "--disable-lcd-text"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: viewport, height: 1100, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);

  // Measure at 1x first so the scale can be derived from the real layout.
  const cssWidth = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.getBoundingClientRect().width : 0;
  }, selector);
  if (!cssWidth) throw new Error(`selector ${selector} matched nothing at ${url}`);
  // 4x is the ceiling: past that the screenshots get slow and the PNG sequence
  // starts costing gigabytes for no visible gain.
  const scale = explicitScale ? Number(explicitScale) : Math.min(4, Math.max(1, targetWidth / cssWidth));
  console.log(`  ${Math.round(cssWidth)}px css -> scale ${scale.toFixed(2)}x = ${Math.round(cssWidth * scale)}px\n`);
  await page.setViewport({ width: viewport, height: 1100, deviceScaleFactor: scale });
  // Webfonts swap in late and would change the first frames otherwise.
  await page.evaluate(() => document.fonts.ready);

  // ONE evaluate, deliberately. Every step here changes layout or scroll, and
  // splitting them cost two separate bugs: measuring before the canvases were
  // dropped left a stale clip (removing them reflows the page and the card
  // moves), and measuring after .play with everything paused could catch the
  // card mid-collapse. Doing the whole setup and then measuring last means the
  // clip describes exactly what frame 0 will render, and nothing mutates after.
  const setup = await page.evaluate((sel, seconds) => {
    const el = document.querySelector(sel);
    if (!el) return null;

    // behavior:"instant" is load-bearing: global.css sets `scroll-behavior:
    // smooth`, under which scrollIntoView ANIMATES and any rect read on the
    // next line is still the pre-scroll one.
    el.scrollIntoView({ block: "center", behavior: "instant" });

    // SPEED, and not a small effect. The hero runs a WebGL shader on a rAF
    // loop and every other card animates on its own timer; all of it repaints
    // between screenshots even though none of it is inside the clip.
    for (const c of document.querySelectorAll("canvas")) if (!el.contains(c)) c.remove();
    for (const a of document.getAnimations()) a.pause();

    // PlayOnView gates these on an IntersectionObserver; adding the class
    // directly is the same signal without depending on scroll timing. Collect
    // AFTER it - animations that only start with the class are missing before.
    el.classList.add("play");
    globalThis.__anims = el.getAnimations({ subtree: true });
    for (const a of globalThis.__anims) a.pause();

    el.scrollIntoView({ block: "center", behavior: "instant" });

    // Take the union of the box at the start and the middle of the loop, so a
    // card that grows during its cycle is not cropped by a first-frame clip.
    // PAGE coordinates, not viewport. Puppeteer's default screenshot mode is
    // captureBeyondViewport, under which `clip` is measured from the document
    // origin - feeding it a viewport-relative rect silently captured whatever
    // happened to sit at that offset from the top of the page (for the mailbox
    // card, that was the hero window, several screens up).
    const at = (ms) => {
      for (const a of globalThis.__anims) a.currentTime = ms;
      const r = el.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
    };
    const a0 = at(0);
    const a1 = at((seconds / 2) * 1000);
    at(0);
    return {
      count: globalThis.__anims.length,
      box: {
        x: Math.min(a0.x, a1.x),
        y: Math.min(a0.y, a1.y),
        width: Math.max(a0.w, a1.w),
        height: Math.max(a0.h, a1.h),
      },
    };
  }, selector, seconds);

  if (!setup) throw new Error(`selector ${selector} matched nothing at ${url}`);
  const box = setup.box;
  if (!box.width || !box.height) throw new Error(`${selector} measured ${box.width}x${box.height}`);
  console.log(`  clip ${Math.round(box.width)}x${Math.round(box.height)}, ${setup.count} animations stepping...\n`);

  const clip = {
    x: Math.floor(box.x),
    y: Math.floor(box.y),
    width: Math.ceil(box.width),
    height: Math.ceil(box.height),
  };

  for (let i = 0; i < total; i++) {
    const ms = (i / fps) * 1000;
    await page.evaluate((t) => {
      for (const a of globalThis.__anims) a.currentTime = t;
    }, ms);
    await page.screenshot({
      path: join(frameDir, `${String(i).padStart(5, "0")}.png`),
      clip,
      optimizeForSpeed: true,
    });
    if (i % 60 === 0) process.stdout.write(`  ${i}/${total}\r`);
  }
  process.stdout.write(`  ${total}/${total}\n`);
} finally {
  await browser.close();
}

const shot = readdirSync(frameDir).filter((f) => f.endsWith(".png"));
if (shot.length !== total) console.log(`  warning: ${shot.length} frames on disk, expected ${total}`);

// Near-lossless: this is a MASTER, everything lossy happens downstream.
execFileSync(
  "ffmpeg",
  ["-y", "-v", "error", "-framerate", String(fps), "-i", join(frameDir, "%05d.png"),
   "-c:v", "libx264", "-crf", "8", "-preset", "slow", "-pix_fmt", "yuv444p", master],
  { stdio: "inherit" },
);
if (!has("keep-frames")) rmSync(frameDir, { recursive: true, force: true });

const dims = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=width,height", "-of", "csv=p=0", master], { encoding: "utf8" }).trim();
console.log(`\n  -> ${master.replace(WEB + "/", "")}  ${dims}\n`);

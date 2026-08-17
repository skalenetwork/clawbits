#!/usr/bin/env node
/**
 * Demo transcoder: one master recording in, every shipping format out.
 *
 * The recording itself is Screen Studio's job (click-zoom, cursor smoothing,
 * easing - none of which ffmpeg can fake). Export a HIGH-BITRATE MASTER from
 * it, at 2x the size the demo will display at, and point this at the file.
 * Everything downstream of that export is deterministic, so re-cutting a demo
 * after a UI change is one command rather than a fiddle in three tools.
 *
 * WHAT COMES OUT (into public/demos/)
 *
 *   <name>.webm         VP9. First <source>; ~30% smaller than the mp4.
 *   <name>.mp4          h.264 High/yuv420p. The universal fallback.
 *   <name>.gif          gifski. For README/Slack/email only - see below.
 *   <name>.poster.webp  First frame. Also what reduced-motion users get.
 *
 * and an entry in src/data/demos.json carrying intrinsic width/height, which
 * Demo.astro reads to reserve the box before the video loads. A demo missing
 * from that manifest fails the build rather than shipping layout shift.
 *
 * WHY 2x
 *
 * Browsers only take h.264 in yuv420p - chroma at half resolution in both
 * axes. On UI footage that lands directly on the accent-red text and the
 * hairline rules, which are exactly the pixels the eye checks. Encoding at
 * twice the CSS display width pushes the chroma error below one display
 * pixel and it stops being visible. --width is the ENCODE width: keep the
 * component's rendered width at half of it.
 *
 * WHY THE GIF IS THE SIDE OUTPUT
 *
 * 256 colors and 1-bit alpha, at 10-20x the bytes of the mp4. It exists for
 * surfaces that cannot take a <video> at all. Notably the 1-bit alpha is why
 * --gif-frame composites the rounded corner over a SOLID background instead
 * of leaving it transparent: a transparent rounded corner in a GIF is a hard
 * on/off staircase against whatever it lands on. The web path never needs
 * this - Demo.astro rounds with CSS, which anti-aliases against the shader.
 *
 * USAGE
 *
 *   node scripts/make-demo.mjs ~/Movies/lobstertalk.mov --name lobstertalk
 *   node scripts/make-demo.mjs master.mov --name email --gif-frame --trim 1.5,12
 *
 * Options:
 *   --name <slug>          output slug          (default: master's basename)
 *   --width <px>           encode width         (default 1280 = 2x a 640 box)
 *   --fps <n>              video fps            (default 30)
 *   --crf <n>              h.264 quality        (default 18, lower = better)
 *   --trim <start[,end]>   seconds, on the master's timeline
 *   --poster <sec>         poster frame time    (default 0)
 *   --gif-width <px>       (default 960)   --gif-fps <n>       (default 20)
 *   --gif-quality <1-100>  (default 92)    --gif-frame         bake a frame
 *   --radius <px>          gif frame radius     (default 16)
 *   --pad <px>             gif frame padding    (default 32)
 *   --bg <hex>             gif frame background (default #141311 = --color-canvas)
 *   --out <dir>            destination (default public/demos + manifest)
 *   --no-gif / --no-webm   skip an output
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_DIR = join(WEB, "public", "demos");
const MANIFEST = join(WEB, "src", "data", "demos.json");

/* ---------- args ---------- */

const argv = process.argv.slice(2);
const master = argv.find((a) => !a.startsWith("--"));
if (!master) {
  console.error(
    "\n  usage: node scripts/make-demo.mjs <master.mov> [--name slug] [--width 1280]\n" +
      "         [--fps 30] [--crf 18] [--trim start,end] [--poster sec]\n" +
      "         [--gif-width 960] [--gif-fps 20] [--gif-quality 92] [--gif-frame]\n" +
      "         [--radius 16] [--pad 32] [--bg '#141311'] [--no-gif] [--no-webm]\n" +
      "\n  full notes in the header of this file\n",
  );
  process.exit(1);
}
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const name = String(flag("name", basename(master, extname(master))))
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
const reqWidth = Number(flag("width", 1280));
const fps = Number(flag("fps", 30));
const crf = Number(flag("crf", 18));
const posterAt = Number(flag("poster", 0));
const gifWidth = Number(flag("gif-width", 960));
const gifFps = Number(flag("gif-fps", 20));
const gifQuality = Number(flag("gif-quality", 92));
const gifFrame = has("gif-frame");
const radius = Number(flag("radius", 16));
const pad = Number(flag("pad", 32));
const bg = String(flag("bg", "#141311"));
const trim = flag("trim", null);

/** Default is the site's shipped asset dir, which also gets a manifest entry.
 * Anything else (a social export, a scratch cut) is NOT a site asset, so it is
 * written wherever asked and left out of demos.json - a manifest entry with no
 * file under public/demos would fail the next build. */
const outFlag = flag("out", null);
const OUT_DIR = outFlag ? (outFlag.startsWith("/") ? outFlag : join(WEB, outFlag)) : SITE_DIR;
const isSiteAsset = OUT_DIR === SITE_DIR;

if (!existsSync(master)) die(`master not found: ${master}`);
if (!name) die("--name produced an empty slug");
if (reqWidth % 2) die(`--width must be even (yuv420p): got ${reqWidth}`);

/* ---------- helpers ---------- */

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}
function run(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    die(`${bin} failed:\n${err.stderr || err.message}`);
  }
}
function hasBin(bin) {
  try {
    execFileSync("command", ["-v", bin], { shell: "/bin/bash", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function need(bin, hint) {
  try {
    execFileSync("command", ["-v", bin], { shell: "/bin/bash", stdio: "ignore" });
  } catch {
    die(`${bin} not installed. ${hint}`);
  }
}
const mb = (p) => (statSync(p).size / 1e6).toFixed(2);

/** Seek/duration args, shared by every encode so the outputs stay in sync. */
function trimArgs() {
  if (!trim) return [];
  const [start, end] = String(trim).split(",").map(Number);
  const out = ["-ss", String(start || 0)];
  if (end) out.push("-t", String(end - (start || 0)));
  return out;
}

/* ---------- preflight ---------- */

need("ffmpeg", "brew install ffmpeg");
need("ffprobe", "brew install ffmpeg");
if (!has("no-gif")) need("gifski", "brew install gifski");
if (gifFrame) need("magick", "brew install imagemagick");

const probe = JSON.parse(
  run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json", master,
  ]),
);
const src = probe.streams[0];
const srcDuration = Number(probe.format.duration);
if (!src?.width) die(`no video stream in ${master}`);

/** Never upscale. --width is a ceiling, not a resize target: masters from
 * record-visual.mjs come out near 1200px, and blowing those up to the 1280
 * default would cost sharpness for nothing. */
const width = Math.min(reqWidth, 2 * Math.floor(src.width / 2));
if (width !== reqWidth) console.log(`  (capped to the master's ${width}px, no upscale)`);

/** Output height, locked to the master's aspect and forced even for yuv420p. */
const height = 2 * Math.round((width * src.height) / src.width / 2);
const duration = trim
  ? (() => {
      const [s, e] = String(trim).split(",").map(Number);
      return (e || srcDuration) - (s || 0);
    })()
  : srcDuration;

mkdirSync(OUT_DIR, { recursive: true });
if (isSiteAsset) mkdirSync(dirname(MANIFEST), { recursive: true });

console.log(`\n  ${name}  ${src.width}x${src.height} -> ${width}x${height}  ${duration.toFixed(1)}s\n`);

const scale = `scale=${width}:${height}:flags=lanczos`;
const outputs = {};

/* ---------- mp4 (h.264) ---------- */

const mp4 = join(OUT_DIR, `${name}.mp4`);
run("ffmpeg", [
  "-y", ...trimArgs(), "-i", master,
  "-vf", `fps=${fps},${scale}`,
  "-c:v", "libx264", "-profile:v", "high", "-crf", String(crf), "-preset", "veryslow",
  "-pix_fmt", "yuv420p",
  // Autoplaying loops are decoded from byte 0, so the moov atom has to lead.
  "-movflags", "+faststart",
  "-an", mp4,
]);
outputs.mp4 = mb(mp4);
console.log(`  mp4     ${outputs.mp4} MB`);

/* ---------- webm (VP9) ---------- */

if (!has("no-webm")) {
  const webm = join(OUT_DIR, `${name}.webm`);
  run("ffmpeg", [
    "-y", ...trimArgs(), "-i", master,
    "-vf", `fps=${fps},${scale}`,
    "-c:v", "libvpx-vp9", "-crf", String(crf + 13), "-b:v", "0",
    "-deadline", "good", "-cpu-used", "1", "-row-mt", "1", "-tile-columns", "1",
    "-pix_fmt", "yuv420p", "-an", webm,
  ]);
  outputs.webm = mb(webm);
  console.log(`  webm    ${outputs.webm} MB`);
}

/* ---------- poster ---------- */

// Homebrew's ffmpeg 9 ships WITHOUT libwebp (`ffmpeg -encoders | grep webp`
// is empty), and asking it for a .webp fails the whole run at the last step.
// So the frame lands as PNG and ImageMagick - which does carry libwebp - makes
// the webp. No magick on the box just means a heavier poster, not a failure.
const posterPng = join(OUT_DIR, `${name}.poster.png`);
run("ffmpeg", [
  "-y", "-ss", String((trim ? Number(String(trim).split(",")[0]) || 0 : 0) + posterAt),
  "-i", master, "-frames:v", "1", "-vf", scale, posterPng,
]);
let posterExt = "png";
let poster = posterPng;
if (hasBin("magick")) {
  poster = join(OUT_DIR, `${name}.poster.webp`);
  run("magick", [posterPng, "-quality", "90", "-define", "webp:method=6", poster]);
  rmSync(posterPng, { force: true });
  posterExt = "webp";
}
outputs.poster = mb(poster);
console.log(`  poster  ${outputs.poster} MB  (${posterExt})`);

/* ---------- gif ---------- */

if (!has("no-gif")) {
  const gif = join(OUT_DIR, `${name}.gif`);
  let gifSource = master;
  let scratch = null;
  // run() exits the process on ffmpeg failure, so a crashed earlier run leaves
  // its intermediate behind. Clear it rather than encoding next to it.
  for (const stale of [`.${name}.pre.mp4`, `.${name}.mask.png`]) {
    rmSync(join(OUT_DIR, stale), { force: true });
  }

  if (gifFrame || trim) {
    // gifski takes video or PNGs, not a filtergraph, so the frame has to be
    // baked into an intermediate. Near-lossless: this file is thrown away and
    // any loss here would be quantized twice.
    const p = gifFrame ? pad : 0;
    const inner = 2 * Math.round((gifWidth - 2 * p) / 2);
    const innerH = 2 * Math.round((inner * src.height) / src.width / 2);
    const outH = innerH + 2 * p;
    const mask = join(OUT_DIR, `.${name}.mask.png`);
    scratch = join(OUT_DIR, `.${name}.pre.mp4`);

    // Anti-aliased white rounded rect on black: ffmpeg reads it as the alpha
    // channel, so the soft edge survives into the composite (and only gets
    // hard-clipped by the GIF's 1-bit alpha at the very last step, where it
    // is already sitting on --bg rather than on the page).
    if (gifFrame) {
      run("magick", [
        "-size", `${inner}x${innerH}`, "xc:black", "-fill", "white",
        "-draw", `roundrectangle 0,0,${inner - 1},${innerH - 1},${radius},${radius}`,
        "-alpha", "off", mask,
      ]);
      // EVERY input here must be bounded. `color=` and `-loop 1` are both
      // infinite sources, and overlay's shortest=1 does NOT terminate the graph
      // when the finite stream is the one being overlaid: an earlier cut of
      // this ran until it had written 104 MB of padding. So the color source
      // carries d=, the looped mask carries -t, and -frames:v caps the output
      // regardless of what the filtergraph thinks.
      run("ffmpeg", [
        "-y", ...trimArgs(), "-i", master,
        "-loop", "1", "-t", String(duration), "-i", mask,
        "-filter_complex",
        `color=c=${bg}:s=${gifWidth}x${outH}:r=${gifFps}:d=${duration}[bg];` +
          `[0:v]fps=${gifFps},scale=${inner}:${innerH}:flags=lanczos,format=rgba[v];` +
          `[1:v]format=gray[m];[v][m]alphamerge[fg];` +
          `[bg][fg]overlay=${p}:${p}:shortest=1,format=yuv420p`,
        "-frames:v", String(Math.ceil(duration * gifFps)),
        "-c:v", "libx264", "-crf", "10", "-preset", "fast", "-an", scratch,
      ]);
      rmSync(mask, { force: true });
    } else {
      run("ffmpeg", [
        "-y", ...trimArgs(), "-i", master,
        "-vf", `fps=${gifFps},scale=${inner}:${innerH}:flags=lanczos`,
        "-frames:v", String(Math.ceil(duration * gifFps)),
        "-c:v", "libx264", "-crf", "10", "-preset", "fast", "-an", scratch,
      ]);
    }
    gifSource = scratch;
  }

  run("gifski", [
    "-o", gif, "-W", String(gifWidth), "-r", String(gifFps),
    "-Q", String(gifQuality), "--repeat", "0", "--quiet",
    gifSource,
  ]);
  if (scratch) rmSync(scratch, { force: true });
  outputs.gif = mb(gif);
  const over = Number(outputs.gif) > 10;
  console.log(`  gif     ${outputs.gif} MB${over ? "   <- over GitHub's 10 MB limit; drop --gif-width or --gif-fps" : ""}`);
}

/* ---------- manifest ---------- */

if (!isSiteAsset) {
  console.log(`\n  -> ${OUT_DIR}/${name}.*  (export only, not registered in demos.json)\n`);
  process.exit(0);
}

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
manifest[name] = {
  width,
  height,
  duration: Number(duration.toFixed(2)),
  fps,
  webm: !has("no-webm"),
  gif: !has("no-gif"),
  poster: posterExt,
};
writeFileSync(
  MANIFEST,
  JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]])), null, 2) + "\n",
);

console.log(`\n  -> public/demos/${name}.*  +  src/data/demos.json`);
console.log(`  render it at ${width / 2}px CSS width:  <Demo name="${name}" />\n`);

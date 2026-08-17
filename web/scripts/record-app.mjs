#!/usr/bin/env node
/**
 * Records a scripted walkthrough of the REAL app: open a few chats, send a
 * message, capture the whole thing to a video master.
 *
 * Unlike record-visual.mjs, this cannot step a timeline. The landing-page
 * cards are CSS loops that can be paused and walked frame by frame; a live
 * React app answering a live backend can only be recorded as it happens. So
 * this drives Chrome through a real session and screencasts it in real time.
 *
 * AUTH. /api/auth/dev/login resolves by EMAIL, so signing in as the org owner
 * finds the existing row rather than creating anything - no new user, no
 * second personal org. It only works because dev auth is enabled locally
 * (`GET /api/auth/dev/enabled` -> 200); against a deployment this whole script
 * is inert. The fetch runs from the page so the session cookie is stored for
 * the app's own origin, and Vite proxies /api to the backend.
 *
 * A FAKE CURSOR is injected. Headless Chrome draws no pointer, so a recording
 * of real clicks looks like a UI changing on its own. The dot below moves to
 * each target, pauses, then the click fires - which is what makes the
 * walkthrough legible as someone using the app.
 *
 * Pair it with scripts/seed_dev_org.py: an empty org films badly.
 *
 *   uv run python scripts/seed_dev_org.py --owner you@example.com
 *   node scripts/record-app.mjs --email you@example.com
 *   node scripts/make-demo.mjs demo-exports/app-master.webm --name app --out demo-exports
 *
 * Options:
 *   --email <addr>    who to sign in as       (required)
 *   --url <url>       app origin              (default http://localhost:5173)
 *   --chats a,b,c     sidebar labels to visit (default Engineering,Incidents,Quill)
 *   --message <text>  what to send in the last one
 *   --scale <n>       deviceScaleFactor       (default 2)
 *   --width/--height  viewport                (default 1440x900)
 *   --out <dir>       master destination      (default web/demo-exports)
 *   --headful         watch it run
 */

import puppeteer from "puppeteer-core";
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(`--${n}`);

const email = flag("email", null);
if (!email) {
  console.error("\n  --email is required (the dev account to sign in as)\n");
  process.exit(1);
}
const url = String(flag("url", "http://localhost:5173"));
const chats = String(flag("chats", "Engineering,Incidents,Quill")).split(",").map((s) => s.trim());
const message = String(flag("message", "can you summarise today's incidents?"));
const scale = Number(flag("scale", 2));
const vw = Number(flag("width", 1440));
const vh = Number(flag("height", 900));
const outDir = join(WEB, String(flag("out", "demo-exports")));
const master = join(outDir, "app-master.webm");

if (!existsSync(CHROME)) {
  console.error(`\n  Google Chrome not found at ${CHROME}\n`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: !has("headful"),
  args: ["--force-color-profile=srgb", "--hide-scrollbars", "--font-render-hinting=none"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: vw, height: vh, deviceScaleFactor: scale });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await wait(1200);

  const login = await page.evaluate(async (addr) => {
    const r = await fetch("/api/auth/dev/login", {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: addr }),
    });
    return r.status;
  }, email);
  if (login !== 200) throw new Error(`dev login failed with ${login} - is dev auth enabled?`);
  console.log(`  signed in as ${email}`);

  // waitUntil:"networkidle0" never settles here - the app holds an SSE stream
  // open for realtime, so the network is never quiet.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await wait(3500);

  // The "What's new" release modal covers the whole UI on a fresh profile,
  // and puppeteer starts from a fresh profile every run.
  const dismissed = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^got it$/i.test((x.innerText || "").trim()));
    if (!b) return false;
    b.click();
    return true;
  });
  if (dismissed) console.log("  dismissed the release modal");
  await wait(900);

  await page.evaluate(() => {
    const dot = document.createElement("div");
    dot.id = "__demo_cursor";
    Object.assign(dot.style, {
      position: "fixed", left: "0", top: "0", width: "18px", height: "18px",
      borderRadius: "50%", background: "rgba(255,255,255,.92)",
      boxShadow: "0 0 0 1.5px rgba(0,0,0,.45), 0 4px 14px rgba(0,0,0,.45)",
      zIndex: "2147483647", pointerEvents: "none",
      transform: "translate(-50%,-50%)", transition: "left .55s cubic-bezier(.22,1,.36,1), top .55s cubic-bezier(.22,1,.36,1)",
      opacity: "0",
    });
    document.body.appendChild(dot);
    globalThis.__moveCursor = (x, y) => {
      dot.style.opacity = "1";
      dot.style.left = `${x}px`;
      dot.style.top = `${y}px`;
    };
    globalThis.__pressCursor = () => {
      dot.animate(
        [{ transform: "translate(-50%,-50%) scale(1)" }, { transform: "translate(-50%,-50%) scale(.7)" }, { transform: "translate(-50%,-50%) scale(1)" }],
        { duration: 220, easing: "ease-out" },
      );
    };
  });

  /** Move the dot to an element, let it land, then click it for real. */
  const clickLabel = async (label) => {
    const box = await page.evaluate((text) => {
      const a = [...document.querySelectorAll('a[href^="/channels/"]')].find((el) =>
        (el.innerText || "").toLowerCase().includes(text.toLowerCase()),
      );
      if (!a) return null;
      const r = a.getBoundingClientRect();
      globalThis.__moveCursor(r.x + r.width / 2, r.y + r.height / 2);
      globalThis.__target = a;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, label);
    if (!box) {
      console.log(`  ! no sidebar row matching "${label}" - skipped`);
      return false;
    }
    await wait(700);
    await page.evaluate(() => globalThis.__pressCursor());
    await wait(160);
    await page.mouse.click(box.x, box.y);
    return true;
  };

  console.log("  recording...");
  const recorder = await page.screencast({ path: master });

  await wait(1400);
  for (const label of chats) {
    const ok = await clickLabel(label);
    await wait(ok ? 2300 : 200);
  }

  // Type into whichever channel we landed in last.
  const composer = 'textarea[placeholder^="Message"]';
  const field = await page.$(composer);
  if (field) {
    const r = await field.boundingBox();
    if (r) {
      await page.evaluate((x, y) => globalThis.__moveCursor(x, y), r.x + 40, r.y + r.height / 2);
      await wait(650);
      await page.evaluate(() => globalThis.__pressCursor());
    }
    await field.click();
    await wait(400);
    await page.type(composer, message, { delay: 55 });
    await wait(700);
    await page.keyboard.press("Enter");
    console.log(`  sent: "${message}"`);
    await wait(3600);
  } else {
    console.log("  ! no composer found - nothing sent");
    await wait(1200);
  }

  await recorder.stop();
  console.log(`\n  -> ${master.replace(WEB + "/", "")}`);
} finally {
  await browser.close();
}

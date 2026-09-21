#!/usr/bin/env node
// Requires a built-site preview; override DECK_URL and CHROME_PATH as needed.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(process.env.DECK_URL ?? "http://127.0.0.1:4327/deck/", { waitUntil: "networkidle0" });
  assert.equal(await page.$$eval("h1", nodes => nodes.length), 1);
  assert.equal(await page.$$(".app-preview, .message, img[src^='/avatars/']").then(nodes => nodes.length), 0, "No fabricated product UI");
  assert.equal(await page.$$eval(".slide", nodes => nodes.length), 21);
  assert.equal(await page.$$eval("[id]", nodes => new Set(nodes.map(node => node.id)).size === nodes.length), true);
  assert.equal(await page.$$(".appendix-slide").then(nodes => nodes.length), 8);
  assert.equal(await page.$$eval('.deck a[href^="#"]', nodes => nodes.every(node => document.getElementById(node.hash.slice(1)))), true, "All slide links resolve");
  await page.click('.deck-bar a[href="#appendix"]');
  await page.waitForFunction(() => location.hash === "#appendix");
  await page.click('.appendix-index a[href="#a-controls"]');
  await page.waitForFunction(() => location.hash === "#a-controls");
  await page.click('#a-controls .slide-footer a[href="#appendix"]');
  await page.waitForFunction(() => location.hash === "#appendix");
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); location.hash = "overview"; });
  for (const href of ["https://reef.clawbits.ai", "https://reef.clawbits.ai/deck"]) assert.ok(await page.$(`#reef a[href="${href}"]`));
  for (const [key, hash] of [["ArrowRight", "#problem"], ["End", "#a-docs"], ["Home", "#overview"]]) {
    await page.keyboard.press(key);
    await page.waitForFunction(value => location.hash === value, {}, hash);
  }
  await page.focus("#print-deck");
  await page.keyboard.press("ArrowRight");
  assert.equal(new URL(page.url()).hash, "#overview");
  await page.evaluate(() => { window.print = () => { document.body.dataset.printTest = "called"; }; });
  await page.click("#print-deck");
  assert.equal(await page.$eval("body", node => node.dataset.printTest), "called");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: "/tmp/clawbits-deck-desktop.png" });
  for (const [width, height] of [[1440, 1000], [1280, 720], [768, 1000], [390, 844]]) {
    await page.setViewport({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No overflow at ${width}px`);
    if (width > 720) {
      const issues = await page.$$eval(".slide", slides => slides.flatMap(slide => {
        const rect = slide.getBoundingClientRect();
        const result = [];
        if (Math.abs(rect.width / rect.height - 16 / 9) > .01) result.push(`${slide.id}: aspect ratio`);
        for (const element of slide.querySelectorAll(".slide-heading, .slide-body, .slide-footer, article, figcaption, .appendix-index")) {
          const box = element.getBoundingClientRect();
          if (box.width && (box.bottom > rect.bottom + 1 || box.right > rect.right + 1)) result.push(`${slide.id}: clipped ${element.className || element.tagName}`);
        }
        return result;
      }));
      assert.deepEqual(issues, [], `Slides fit at ${width}×${height}`);
    }
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: "/tmp/clawbits-deck-mobile.png" });
  assert.equal(await page.$$(".product-screenshot img").then(nodes => nodes.length), 4);
  assert.equal(await page.$$(".screenshot-space").then(nodes => nodes.length), 0);
  for (const figure of await page.$$(".product-screenshot")) {
    await figure.evaluate(node => node.scrollIntoView({ behavior: "instant", block: "center" }));
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".product-screenshot img")).filter(img => img.getBoundingClientRect().top < innerHeight && img.getBoundingClientRect().bottom > 0).every(img => img.complete && img.naturalWidth > 0));
  }
  await page.setViewport({ width: 1440, height: 1000 });
  await page.$eval("#participation", node => node.scrollIntoView({ behavior: "instant" }));
  await page.screenshot({ path: "/tmp/clawbits-deck-product.png" });
  await page.emulateMediaType("print");
  await page.pdf({ path: "/tmp/clawbits-deck.pdf", preferCSSPageSize: true, printBackground: true });
  assert.deepEqual(errors, []);
  console.log("Deck verified: anchors, Reef links, keyboard navigation, print action, responsive widths, PDF export.");
} finally { await browser.close(); }

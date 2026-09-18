#!/usr/bin/env node
// Requires a built-site preview; override DECK_URL and CHROME_PATH as needed.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(process.env.DECK_URL ?? "http://localhost:4321/deck/", { waitUntil: "networkidle0" });
  assert.equal(await page.$$eval("h1", nodes => nodes.length), 1);
  assert.equal(await page.$$(".app-preview, .message, img[src^='/avatars/']").then(nodes => nodes.length), 0, "No fabricated product UI");
  assert.equal(await page.$$eval(".slide", nodes => nodes.length), 14);
  assert.equal(await page.$$eval("[id]", nodes => new Set(nodes.map(node => node.id)).size === nodes.length), true);
  for (const href of ["https://reef.clawbits.ai", "https://reef.clawbits.ai/deck"]) assert.ok(await page.$(`#reef a[href="${href}"]`));
  for (const [key, hash] of [["ArrowRight", "#problem"], ["End", "#next"], ["Home", "#overview"]]) {
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
  for (const width of [1440, 768, 390]) {
    await page.setViewport({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No overflow at ${width}px`);
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

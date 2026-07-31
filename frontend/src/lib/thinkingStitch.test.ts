import { describe, it, expect } from "vitest";
import { stitchThinkingTail, THINKING_ACC_MAX_CHARS } from "./thinkingStitch";

/** Fold a sequence of tails the way useChannelEvents does for one burst. */
function reconstruct(tails: string[]): string {
  return tails.reduce((acc, t) => stitchThinkingTail(acc, t), "");
}

describe("stitchThinkingTail", () => {
  it("seeds from the first tail verbatim", () => {
    expect(stitchThinkingTail("", "The user asked about SKALE gas.")).toBe(
      "The user asked about SKALE gas.",
    );
  });

  it("welds an overlapping continuation tail onto the accumulated text", () => {
    const acc = "The user asked about SKALE gas.";
    // Next tail is a suffix of the grown text, prefixed with the plugin's "…".
    const tail = "…about SKALE gas. I should check the docs.";
    expect(stitchThinkingTail(acc, tail)).toBe(
      "The user asked about SKALE gas. I should check the docs.",
    );
  });

  it("is a no-op when the new tail is already fully contained (no growth)", () => {
    const acc = "The user asked about SKALE gas.";
    expect(stitchThinkingTail(acc, "…about SKALE gas.")).toBe(acc);
    expect(stitchThinkingTail(acc, "The user asked about SKALE gas.")).toBe(acc);
  });

  it("marks a gap when the burst outran the tail window (no overlap)", () => {
    const acc = "The user asked about SKALE gas.";
    const jumped = "…provide reliable details to the user!";
    expect(stitchThinkingTail(acc, jumped)).toBe(
      "The user asked about SKALE gas. … provide reliable details to the user!",
    );
  });

  it("keeps a leading … from the very first tail (joined mid-stream)", () => {
    // We connected after the thought had already passed the plugin's cap, so the
    // true beginning was never sent — the marker stays, honestly.
    const first = "…citations for every factual statement to back up my information.";
    expect(stitchThinkingTail("", first)).toBe(first);
  });

  it("reconstructs the full thought across a realistic overlapping sequence", () => {
    // A burst growing past the cap, delivered as ~1/s sliding tails that overlap.
    const full =
      "I need to answer the pricing question. I should provide citations for " +
      "every factual statement to back up my information. It's important to be " +
      "accurate and provide reliable details to the user!";
    const tails = [
      "I need to answer the pricing question. I should provide citations for every",
      "…should provide citations for every factual statement to back up my information.",
      "…back up my information. It's important to be accurate and provide reliable details to the user!",
    ];
    expect(reconstruct(tails)).toBe(full);
  });

  it("ignores blank / whitespace-only tails", () => {
    const acc = "some reasoning";
    expect(stitchThinkingTail(acc, "   ")).toBe(acc);
    expect(stitchThinkingTail(acc, "")).toBe(acc);
  });

  it("caps a pathologically long reconstruction, keeping the freshest text", () => {
    const long = "x".repeat(THINKING_ACC_MAX_CHARS);
    const out = stitchThinkingTail(long, "y fresh conclusion here");
    expect(out.length).toBeLessThanOrEqual(THINKING_ACC_MAX_CHARS + 1); // +1 for the leading …
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("fresh conclusion here")).toBe(true);
  });
});

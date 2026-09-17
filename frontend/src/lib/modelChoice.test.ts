import { describe, expect, it } from "vitest";

import type { ModelOption, ThinkingLevel } from "./api";
import { effortOptions, keepThinking, thinkOnLevel, vendorOf } from "./modelChoice";

const option = (levels: ThinkingLevel[], default_level: ThinkingLevel | null): ModelOption => ({
  ref: "anthropic/claude-opus-5",
  provider: "anthropic",
  name: "Claude Opus 5",
  levels,
  default_level,
});

const labels = (levels: ThinkingLevel[]) => effortOptions(levels).segments.map((s) => `${s.label}:${s.level}`);

describe("vendorOf", () => {
  it("takes the namespace right before the model id", () => {
    expect(vendorOf("anthropic/claude-opus-5")).toBe("anthropic");
    expect(vendorOf("openrouter/anthropic/claude-opus-5")).toBe("anthropic");
    expect(vendorOf("openrouter/auto")).toBe("openrouter");
    expect(vendorOf("ollama")).toBe("ollama");
  });
});

describe("effortOptions", () => {
  it("maps an OpenRouter reasoning model to low, medium, high", () => {
    expect(labels(["off", "minimal", "low", "medium", "high"])).toEqual(["Low:low", "Medium:medium", "High:high"]);
    expect(effortOptions(["off", "minimal", "low", "medium", "high"]).think).toBe(true);
  });

  it("saves max when supported, else xhigh", () => {
    expect(labels(["off", "low", "medium", "high", "xhigh", "adaptive", "max"])).toEqual([
      "Low:low",
      "Medium:medium",
      "High:high",
      "Max:max",
    ]);
    expect(labels(["off", "minimal", "low", "medium", "high", "xhigh"])).toContain("Max:xhigh");
  });

  it("never offers minimal, adaptive or ultra", () => {
    expect(labels(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])).toEqual([
      "Low:low",
      "Medium:medium",
      "High:high",
      "Max:max",
    ]);
  });

  it("hides the switch without off", () => {
    expect(effortOptions(["minimal", "low", "medium", "high", "xhigh", "adaptive", "max"])).toMatchObject({
      think: false,
    });
  });

  it("renders segments only when two or more exist", () => {
    expect(effortOptions(["off", "high"])).toEqual({ segments: [], think: true });
  });

  it("renders nothing for off only or off with adaptive", () => {
    expect(effortOptions(["off"])).toEqual({ segments: [], think: false });
    expect(effortOptions(["off", "adaptive"])).toEqual({ segments: [], think: false });
  });
});

describe("thinkOnLevel", () => {
  it("uses the default level when it maps to a segment", () => {
    expect(thinkOnLevel(option(["off", "low", "medium", "high", "xhigh", "max"], "high"))).toBe("high");
    expect(thinkOnLevel(option(["off", "low", "medium", "high", "xhigh"], "xhigh"))).toBe("xhigh");
  });

  it("falls back to medium, then the lowest segment", () => {
    expect(thinkOnLevel(option(["off", "low", "medium", "high", "max"], "off"))).toBe("medium");
    expect(thinkOnLevel(option(["off", "low", "xhigh", "max"], "xhigh"))).toBe("low");
    expect(thinkOnLevel(option(["off", "high"], null))).toBe("high");
  });

  it("returns null without any segment", () => {
    expect(thinkOnLevel(option(["off", "adaptive"], "adaptive"))).toBeNull();
  });
});

describe("keepThinking", () => {
  it("keeps a level the new model has, else inherits", () => {
    expect(keepThinking(option(["off", "low", "high"], "high"), "high")).toBe("high");
    expect(keepThinking(option(["off", "low", "high"], "high"), "max")).toBeNull();
    expect(keepThinking(option(["off"], "off"), null)).toBeNull();
  });
});

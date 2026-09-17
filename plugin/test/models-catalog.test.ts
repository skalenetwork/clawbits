import { describe, expect, it } from "bun:test";
import { toRows } from "../src/models/catalog.js";

describe("toRows", () => {
  it("maps every auth-visible model to a sorted row with its thinking policy", () => {
    const rows = toRows(
      {
        byProvider: new Map([
          ["openrouter", new Set(["auto", "anthropic/claude-opus-5", "openai/gpt-5.6:batch"])],
          ["anthropic", new Set(["claude-opus-5"])],
        ]),
        modelNames: new Map([["anthropic/claude-opus-5", "Claude Opus 5"]]),
      },
      (provider, model) =>
        model === "auto"
          ? { levels: [{ id: "off", label: "Off" }] }
          : {
              levels: ["off", "low", "medium", "high"].map((id) => ({ id, label: id })),
              defaultLevel: provider === "anthropic" ? "high" : "medium",
            },
    );
    expect(rows).toEqual([
      {
        ref: "anthropic/claude-opus-5",
        provider: "anthropic",
        name: "Claude Opus 5",
        levels: ["off", "low", "medium", "high"],
        default_level: "high",
      },
      {
        ref: "openrouter/anthropic/claude-opus-5",
        provider: "openrouter",
        name: "anthropic/claude-opus-5",
        levels: ["off", "low", "medium", "high"],
        default_level: "medium",
      },
      {
        ref: "openrouter/auto",
        provider: "openrouter",
        name: "auto",
        levels: ["off"],
        default_level: null,
      },
    ]);
  });
});

import { describe, expect, it } from "bun:test";
import { INHERIT, planSessionPatch, type ModelChoice } from "../src/model-choice.js";

type Entry = NonNullable<Parameters<typeof planSessionPatch>[0]>;

const OPUS = "anthropic/claude-opus-5";
const AUTO = "openrouter/auto";

function entry(fields: Partial<Entry> = {}): Entry {
  return { sessionId: "s1", updatedAt: 1, ...fields };
}

function stamped(applied: ModelChoice, fields: Partial<Entry> = {}): Entry {
  return entry({ pluginExtensions: { clawbits: { modelChoice: applied } }, ...fields });
}

const opusOverride = { providerOverride: "anthropic", modelOverride: "claude-opus-5" };

describe("planSessionPatch", () => {
  it("does nothing when a missing entry inherits", () => {
    expect(planSessionPatch(undefined, INHERIT)).toBeNull();
  });

  it("sets a model on a missing entry and stamps it", () => {
    expect(planSessionPatch(undefined, { model: OPUS, thinking: null })).toEqual({
      model: OPUS,
      thinking: undefined,
      applied: { model: OPUS, thinking: null },
    });
  });

  it("skips a model the entry already overrides", () => {
    expect(planSessionPatch(entry(opusOverride), { model: OPUS, thinking: null })).toBeNull();
  });

  it("replaces a different override", () => {
    const patch = planSessionPatch(entry(opusOverride), { model: AUTO, thinking: null });
    expect(patch?.model).toBe(AUTO);
    expect(patch?.applied).toEqual({ model: AUTO, thinking: null });
  });

  it("never touches the model of a locked entry but still applies thinking", () => {
    const locked = entry({ ...opusOverride, modelSelectionLocked: true });
    expect(planSessionPatch(locked, { model: AUTO, thinking: null })).toBeNull();
    expect(planSessionPatch(locked, { model: AUTO, thinking: "high" })).toEqual({
      model: undefined,
      thinking: "high",
      applied: { model: null, thinking: "high" },
    });
  });

  it("leaves an active auto-fallback from the desired model alone", () => {
    const fallback = entry({
      providerOverride: "openrouter",
      modelOverride: "auto",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-opus-5",
    });
    expect(planSessionPatch(fallback, { model: OPUS, thinking: null })).toBeNull();
    expect(planSessionPatch(fallback, { model: "openai/gpt-5.6", thinking: null })?.model).toBe(
      "openai/gpt-5.6",
    );
  });

  it("clears a model only when it is still the last-applied one", () => {
    expect(
      planSessionPatch(stamped({ model: OPUS, thinking: null }, opusOverride), INHERIT),
    ).toEqual({ model: null, thinking: undefined, applied: INHERIT });
    expect(planSessionPatch(entry(opusOverride), INHERIT)).toBeNull();
    expect(
      planSessionPatch(stamped({ model: AUTO, thinking: null }, opusOverride), INHERIT),
    ).toBeNull();
  });

  it("clears thinking only when it is still the last-applied one", () => {
    expect(
      planSessionPatch(stamped({ model: null, thinking: "high" }, { thinkingLevel: "high" }), INHERIT),
    ).toEqual({ model: undefined, thinking: null, applied: INHERIT });
    expect(
      planSessionPatch(stamped({ model: null, thinking: "high" }, { thinkingLevel: "low" }), INHERIT),
    ).toBeNull();
  });

  it("sets thinking and keeps the other field's last-applied stamp", () => {
    expect(
      planSessionPatch(stamped({ model: OPUS, thinking: null }, opusOverride), {
        model: OPUS,
        thinking: "max",
      }),
    ).toEqual({ model: undefined, thinking: "max", applied: { model: OPUS, thinking: "max" } });
  });

  it("ignores a malformed stamp", () => {
    const malformed = entry({ ...opusOverride, pluginExtensions: { clawbits: { modelChoice: "opus" } } });
    expect(planSessionPatch(malformed, INHERIT)).toBeNull();
  });
});

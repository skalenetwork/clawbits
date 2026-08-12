import { describe, expect, it } from "vitest";

import { automationsUnsupportedReason, supportsAutomations } from "./automations";

describe("automation runtime support", () => {
  it("supports Hermes and still gates IronClaw", () => {
    expect(supportsAutomations("hermes")).toBe(true);
    expect(automationsUnsupportedReason("hermes")).toBeNull();
    expect(supportsAutomations("ironclaw")).toBe(false);
  });
});

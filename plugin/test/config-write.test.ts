import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enableBrowserByDefault } from "../src/config-write.js";

describe("enableBrowserByDefault", () => {
  it("enables browser when the flag is unset", () => {
    const next = enableBrowserByDefault({});
    assert.deepEqual((next as { browser?: unknown }).browser, { enabled: true });
  });

  it("preserves other browser settings while filling in enabled", () => {
    const next = enableBrowserByDefault({
      browser: { profile: "default" },
    } as Record<string, unknown>);
    assert.deepEqual((next as { browser?: unknown }).browser, {
      profile: "default",
      enabled: true,
    });
  });

  it("does not override an explicit enabled=true", () => {
    const cfg = { browser: { enabled: true } } as Record<string, unknown>;
    const next = enableBrowserByDefault(cfg);
    assert.equal(next, cfg, "returns the same config object unchanged");
  });

  it("does not override a deliberate opt-out (enabled=false)", () => {
    const cfg = { browser: { enabled: false } } as Record<string, unknown>;
    const next = enableBrowserByDefault(cfg);
    assert.equal(next, cfg, "returns the same config object unchanged");
    assert.equal((next as { browser: { enabled: boolean } }).browser.enabled, false);
  });

  it("does not mutate the input config when enabling", () => {
    const cfg = {} as Record<string, unknown>;
    enableBrowserByDefault(cfg);
    assert.equal((cfg as { browser?: unknown }).browser, undefined);
  });
});

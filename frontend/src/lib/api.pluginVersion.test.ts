import {afterEach, describe, expect, it, vi} from "vitest";

import {checkPluginVersion} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkPluginVersion", () => {
  it("asks the server to judge the selected Reef image version", async () => {
    const payload = {
      supported: false,
      plugin_version: "0.15.11",
      min_plugin_version: "0.17.0",
      message: "update required",
    };
    const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: {"Content-Type": "application/json"},
    }));
    vi.stubGlobal("fetch", spy);

    await expect(checkPluginVersion("openclaw", "0.15.11")).resolves.toEqual(payload);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("/api/agentic/version-check");
    expect(headers.get("X-Clawbits-Plugin-Kind")).toBe("openclaw");
    expect(headers.get("X-Clawbits-Plugin-Version")).toBe("0.15.11");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildEnvPatch, type EnvDraftRow } from "@/components/reef/envKeys";
import {
  controlUiAuthUrl,
  reefAgentEnv,
  reefBuildJobs,
  reefDestroy,
  reefPatchEnv,
  reefRestart,
  reefStart,
  reefStop,
  ReefBuildInProgressError,
  ReefSandboxBusyError,
  setReefToken,
  surfaceAuthUrl,
  terminalAuthUrl,
} from "./reefApi";

// These are pure string builders — no network, no live agent. All values below
// are placeholders; never put a real gateway token / terminal password here.
describe("terminalAuthUrl", () => {
  const TOKEN = "test-terminal-password-000";

  it("embeds the fixed `reef` user + password over the https tunnel so ttyd never prompts", () => {
    const url = "https://reef.example.test/s/deadbeefdeadbeefdeadbeefdeadbeef/";
    expect(terminalAuthUrl(url, TOKEN)).toBe(
      `https://reef:${TOKEN}@reef.example.test/s/deadbeefdeadbeefdeadbeefdeadbeef/`,
    );
  });

  it("still embeds over local http (dev DirectPort exposure)", () => {
    expect(terminalAuthUrl("http://127.0.0.1:40002/", TOKEN)).toBe(
      `http://reef:${TOKEN}@127.0.0.1:40002/`,
    );
  });

  it("url-encodes credential-breaking characters in the password", () => {
    // A password with `@`/`:`/`/` must not corrupt the URL authority.
    expect(terminalAuthUrl("https://host/s/d/", "a@b:c/d")).toBe(
      "https://reef:a%40b%3Ac%2Fd@host/s/d/",
    );
  });

  it("returns the URL unchanged when there is no password", () => {
    expect(terminalAuthUrl("https://host/s/d/", null)).toBe("https://host/s/d/");
    expect(terminalAuthUrl("https://host/s/d/", "")).toBe("https://host/s/d/");
  });

  it("leaves a non-http(s) URL untouched", () => {
    expect(terminalAuthUrl("ws://host/", TOKEN)).toBe("ws://host/");
  });
});

describe("controlUiAuthUrl", () => {
  it("appends the gateway token as a client-only `#token=` fragment", () => {
    expect(controlUiAuthUrl("https://host/s/d/", "test-token")).toBe(
      "https://host/s/d/#token=test-token",
    );
    // Trailing slashes are normalized so the fragment lands on a clean path.
    expect(controlUiAuthUrl("https://host/s/d//", "test-token")).toBe(
      "https://host/s/d/#token=test-token",
    );
  });

  it("returns the URL unchanged when there is no token", () => {
    expect(controlUiAuthUrl("https://host/s/d/", null)).toBe("https://host/s/d/");
  });
});

describe("surfaceAuthUrl", () => {
  // Regression: a hermes dashboard sits behind nginx BASIC-AUTH — a `#token=`
  // fragment is never sent to the server, so one-click open landed on the
  // browser's 401 prompt. The hermes branch must embed creds terminal-style.
  it("uses basic-auth creds for a hermes dashboard", () => {
    expect(surfaceAuthUrl("hermes", "https://host/s/d/", "test-pw")).toBe(
      "https://reef:test-pw@host/s/d/",
    );
  });

  it("keeps the `#token=` fragment for openclaw (and unknown kinds)", () => {
    expect(surfaceAuthUrl("openclaw", "https://host/s/d/", "test-token")).toBe(
      "https://host/s/d/#token=test-token",
    );
    expect(surfaceAuthUrl(null, "https://host/s/d/", "test-token")).toBe(
      "https://host/s/d/#token=test-token",
    );
  });

  it("returns the URL unchanged when there is no secret", () => {
    expect(surfaceAuthUrl("hermes", "https://host/s/d/", null)).toBe("https://host/s/d/");
    expect(surfaceAuthUrl("openclaw", "https://host/s/d/", null)).toBe("https://host/s/d/");
  });
});

// ── Transport ────────────────────────────────────────────────────────────────
// These stub `fetch`. Every value below is a placeholder.

const BASE = "https://reef.example.test";
const TEST_TOKEN = "test-admin-token-000";

function stubFetch(status = 200, body: unknown = {}) {
  const spy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function sentRequest(spy: ReturnType<typeof stubFetch>) {
  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: init.method,
    body: typeof init.body === "string" ? init.body : null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setReefToken(null);
});

describe("lifecycle actions", () => {
  it("POSTs to the per-agent lifecycle routes with the id encoded", async () => {
    setReefToken(TEST_TOKEN);
    for (const [fn, suffix] of [
      [reefStart, "start"],
      [reefStop, "stop"],
      [reefRestart, "restart"],
    ] as const) {
      const spy = stubFetch(200, { sandbox_id: "a/b", state: "running" });
      await fn(BASE, "a/b");
      expect(sentRequest(spy)).toMatchObject({
        url: `${BASE}/fleet/a%2Fb/${suffix}`,
        method: "POST",
      });
      vi.unstubAllGlobals();
    }
  });

  it("DELETEs the fleet row itself to destroy an agent, and takes reef's 204", async () => {
    setReefToken(TEST_TOKEN);
    const spy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", spy);
    await expect(reefDestroy(BASE, "a/b")).resolves.toBeUndefined();
    expect(sentRequest(spy)).toMatchObject({ url: `${BASE}/fleet/a%2Fb`, method: "DELETE" });
  });
});

describe("409 mapping", () => {
  it("keeps build-in-progress for the image-build routes", async () => {
    setReefToken(TEST_TOKEN);
    stubFetch(409, { detail: "A build is already running" });
    await expect(reefBuildJobs(BASE)).rejects.toBeInstanceOf(ReefBuildInProgressError);
  });

  it("reports a per-agent 409 as a busy sandbox, not a build", async () => {
    setReefToken(TEST_TOKEN);
    stubFetch(409, { detail: "sandbox busy" });
    await expect(reefRestart(BASE, "agent-1")).rejects.toBeInstanceOf(ReefSandboxBusyError);
  });
});

describe("guest env", () => {
  it("reads env over GET with no key or value in the URL", async () => {
    setReefToken(TEST_TOKEN);
    const spy = stubFetch(200, {
      sandbox_id: "agent-1",
      vars: [],
      editable: true,
      apply_modes: ["restart"],
      state: "running",
    });
    await reefAgentEnv(BASE, "agent-1");
    const req = sentRequest(spy);
    expect(req).toMatchObject({ url: `${BASE}/fleet/agent-1/env`, method: "GET" });
    expect(req.body).toBeNull();
  });

  it("PATCHes the diff in the body - never the path or a query string", async () => {
    setReefToken(TEST_TOKEN);
    const spy = stubFetch(200, {
      sandbox_id: "agent-1",
      changed: true,
      applied: "restart",
      takes_effect: "now",
      state: "running",
      vars: [],
    });
    await reefPatchEnv(BASE, "agent-1", {
      set: { NEW_VAR: "typed-placeholder-value" },
      unset: ["OLD_VAR"],
      apply: "restart",
    });
    const req = sentRequest(spy);
    expect(req.url).toBe(`${BASE}/fleet/agent-1/env`);
    expect(req.method).toBe("PATCH");
    expect(req.url).not.toContain("NEW_VAR");
    expect(req.url).not.toContain("typed-placeholder-value");
    expect(JSON.parse(req.body ?? "null")).toEqual({
      set: { NEW_VAR: "typed-placeholder-value" },
      unset: ["OLD_VAR"],
      apply: "restart",
    });
  });

  it("never sends a value for a key the operator did not retype", async () => {
    setReefToken(TEST_TOKEN);
    const rows: EnvDraftRow[] = [
      { id: "srv:UNTOUCHED_KEY", key: "UNTOUCHED_KEY", value: null, storedLength: 40, removed: false, existing: true },
      { id: "srv:RETYPED_KEY", key: "RETYPED_KEY", value: "typed-placeholder-value", storedLength: 12, removed: false, existing: true },
      { id: "srv:DROPPED_KEY", key: "DROPPED_KEY", value: null, storedLength: 8, removed: true, existing: true },
      { id: "new:1", key: "ABANDONED_KEY", value: "abandoned", storedLength: null, removed: true, existing: false },
    ];
    const patch = buildEnvPatch(rows, "restart");
    expect(patch).toEqual({
      set: { RETYPED_KEY: "typed-placeholder-value" },
      unset: ["DROPPED_KEY"],
      apply: "restart",
    });

    const spy = stubFetch(200, {
      sandbox_id: "agent-1",
      changed: true,
      applied: "restart",
      takes_effect: "now",
      state: "running",
      vars: [],
    });
    await reefPatchEnv(BASE, "agent-1", patch);
    const body = sentRequest(spy).body ?? "";
    expect(body).not.toContain("UNTOUCHED_KEY");
    expect(body).not.toContain("ABANDONED_KEY");
    expect(body).not.toContain("abandoned");
  });
});

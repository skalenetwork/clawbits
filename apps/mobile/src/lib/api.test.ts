import { afterEach, expect, mock, test } from "bun:test";
import { ApiError, auth, isMcpSignInLink, receiveSession, request } from "./api";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  auth.refresh = undefined;
});

test("rotated credentials are persisted before a successful response resolves", async () => {
  let stored = "";
  auth.refresh = async (previous, next) => {
    expect(previous).toBe("old");
    stored = next;
  };
  globalThis.fetch = mock(async () =>
    Response.json({ ok: true }, { headers: { "X-Clawbits-Session": "new" } }),
  ) as unknown as typeof fetch;
  expect(await request<{ ok: boolean }>("/test", "old")).toEqual({ ok: true });
  expect(stored).toBe("new");
});

test("error responses also persist rotated credentials", async () => {
  const refresh = mock(async () => undefined);
  auth.refresh = refresh;
  globalThis.fetch = mock(async () =>
    Response.json(
      { detail: "Not a member" },
      { status: 403, headers: { "X-Clawbits-Session": "new" } },
    ),
  ) as unknown as typeof fetch;
  try {
    await request("/test", "old");
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  }
  expect(refresh).toHaveBeenCalledWith("old", "new");
});

test("unchanged and unauthenticated responses cannot rotate a session", async () => {
  const refresh = mock(async () => undefined);
  auth.refresh = refresh;
  await receiveSession(new Headers({ "X-Clawbits-Session": "same" }), "same");
  await receiveSession(new Headers({ "X-Clawbits-Session": "new" }));
  expect(refresh).not.toHaveBeenCalled();
});

test("network failures stay distinct from invalid credentials", async () => {
  globalThis.fetch = mock(async () => {
    throw new TypeError("Offline");
  }) as unknown as typeof fetch;
  try {
    await request("/test", "old");
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ApiError);
  }
});

test("MCP sign-in links are the ones returning to the Clawbits callback", () => {
  const link = (redirect: string) =>
    `https://auth.example.com/authorize?state=s1&redirect_uri=${encodeURIComponent(redirect)}&resource=x`;
  expect(isMcpSignInLink(link("https://app.clawbits.ai/oauth/mcp/callback/agent_1/agentpit"))).toBe(true);
  expect(isMcpSignInLink(link("http://127.0.0.1:8989/oauth/callback"))).toBe(false);
  expect(isMcpSignInLink("https://example.com/page")).toBe(false);
});

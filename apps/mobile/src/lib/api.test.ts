import { afterEach, expect, mock, test } from "bun:test";
import { api, apiUrl, ApiError, auth, mcpConnectLinkId, postBody, receiveSession, request } from "./api";

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

test("a file-only post omits the message and keeps the file ids", () => {
  expect(postBody("", "uuid-1", ["file-a"])).toEqual({
    client_msg_uuid: "uuid-1",
    file_ids: ["file-a"],
  });
  expect(postBody("hello", "uuid-1", [])).toEqual({
    message: "hello",
    client_msg_uuid: "uuid-1",
  });
});

test("account deletion sends DELETE and surfaces a refusal", async () => {
  const calls: { url: string; method?: string; authorization?: string }[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method,
      authorization: headers.get("Authorization") ?? undefined,
    });
    return calls.length === 1
      ? new Response(null, { status: 204 })
      : Response.json({ detail: "Hand off your agents first" }, { status: 409 });
  }) as unknown as typeof fetch;
  await api.deleteAccount("token");
  try {
    await api.deleteAccount("token");
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("Hand off your agents first");
  }
  expect(calls).toEqual([
    {
      url: `${apiUrl}/api/human/account`,
      method: "DELETE",
      authorization: "Bearer token",
    },
    {
      url: `${apiUrl}/api/human/account`,
      method: "DELETE",
      authorization: "Bearer token",
    },
  ]);
});

test("connect links carry the id of an agent's sign-in", () => {
  const id = "0123456789abcdef0123456789abcdef";
  expect(mcpConnectLinkId(`https://app.clawbits.ai/connect/${id}`)).toBe(id);
  expect(mcpConnectLinkId(`https://app.clawbits.ai/connect/${id}/more`)).toBeUndefined();
  expect(mcpConnectLinkId("https://example.com/page")).toBeUndefined();
});

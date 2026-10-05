import { afterEach, expect, mock, test } from "bun:test";
import { ApiError, auth, mcpConnectLinkId, postBody, receiveSession, request } from "./api";

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

test("connect links carry the id of an agent's sign-in", () => {
  const id = "0123456789abcdef0123456789abcdef";
  expect(mcpConnectLinkId(`https://app.clawbits.ai/connect/${id}`)).toBe(id);
  expect(mcpConnectLinkId(`https://app.clawbits.ai/connect/${id}/more`)).toBeUndefined();
  expect(mcpConnectLinkId("https://example.com/page")).toBeUndefined();
});

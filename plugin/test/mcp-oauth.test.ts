import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { upsertedAuthProfiles } from "openclaw/plugin-sdk/provider-auth";
import type { ClawBitsClient } from "../src/client.js";
import {
  finishMcpSignIn,
  isMcpSignIn,
  MCP_AUTH_PROVIDER,
  refreshMcpCredential,
  registerMcpAuthProvider,
  registerMcpLoginGuard,
  resetMcpOAuthStores,
  startMcpSignIn,
} from "../src/mcp-oauth.js";
import { discoverAuthServer } from "../src/mcp-oauth-client.js";
import { setRuntime } from "../src/runtime.js";
import { memoryState } from "./runtime-state.js";

const CALLBACK = "https://app.clawbits.ai/oauth/mcp/callback";
const CONNECT = "https://app.clawbits.ai/connect/link_1";
const PIT = "https://api.agentpit.dev/mcp";
const AUTH = "https://auth.agentpit.dev";

type Hook = (event: unknown, ctx: unknown) => { block?: boolean; blockReason?: string } | undefined;
type Seen = { url: string; method: string; headers: Headers; body: string };

/** An MCP server that names its metadata in a 401, and its authorization server. */
function oauthServer(overrides: Record<string, (seen: Seen) => Response | undefined> = {}) {
  const seen: Seen[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const routes: Record<string, (s: Seen) => Response | undefined> = {
    [PIT]: () =>
      new Response("", {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="https://api.agentpit.dev/.well-known/oauth-protected-resource/mcp"` },
      }),
    "https://api.agentpit.dev/.well-known/oauth-protected-resource/mcp": () =>
      json({ resource: PIT, authorization_servers: [AUTH], scopes_supported: ["openid"] }),
    [`${AUTH}/.well-known/oauth-authorization-server`]: () =>
      json({
        issuer: AUTH,
        authorization_endpoint: `${AUTH}/authorize`,
        token_endpoint: `${AUTH}/token`,
        registration_endpoint: `${AUTH}/register`,
        code_challenge_methods_supported: ["S256"],
      }),
    [`${AUTH}/register`]: () => json({ client_id: "client-1", token_endpoint_auth_method: "none" }, 201),
    [`${AUTH}/token`]: () => json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "openid offline_access" }),
    ...overrides,
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const s = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") };
    seen.push(s);
    return routes[url]?.(s) ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { seen, fetchFn };
}

function install() {
  const config = { mcp: { servers: { agentpit: { url: PIT, auth: "oauth", oauth: { redirectUrl: "x", scope: "y" } } } } } as unknown as OpenClawConfig;
  const requests: unknown[] = [];
  const hooks = new Map<string, Hook>();
  const providers: unknown[] = [];
  const runtime = {
    state: memoryState(),
    config: {
      mutateConfigFile: async ({ mutate }: { mutate: (draft: OpenClawConfig) => void }) => {
        mutate(config);
      },
    },
  } as unknown as OpenClawPluginApi["runtime"];
  setRuntime(runtime);
  resetMcpOAuthStores();
  const api = {
    on: (name: string, fn: Hook) => hooks.set(name, fn),
    registerProvider: (provider: unknown) => providers.push(provider),
  } as unknown as OpenClawPluginApi;
  registerMcpLoginGuard(api);
  registerMcpAuthProvider(api);
  const client = {
    request: async (method: string, path: string, opts: { json?: unknown }) => {
      requests.push([method, path, opts.json]);
      return { url: path.endsWith("/redirect") ? CALLBACK : CONNECT };
    },
  } as unknown as ClawBitsClient;
  const before = (command: string, requester: unknown = { channel: "clawbits" }) =>
    hooks.get("before_tool_call")!({ toolName: "exec", params: { command } }, { requester });
  return { config, requests, before, client, providers };
}

const originalFetch = globalThis.fetch;
let server: ReturnType<typeof oauthServer>;
const useServer = (overrides?: Parameters<typeof oauthServer>[0]) => {
  server = oauthServer(overrides);
  globalThis.fetch = server.fetchFn;
  return server;
};
beforeEach(() => {
  upsertedAuthProfiles.length = 0;
  useServer();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const signIn = { server: "agentpit", code: "code-1", state: "s1", channel_id: "room", human_id: 7 };
const linked = (requests: unknown[]) => new URL((requests.at(-1) as [string, string, { url: string }])[2].url);

describe("discovering a server's sign-in", () => {
  it("follows the 401's resource metadata to the authorization server", async () => {
    expect(await discoverAuthServer(server.fetchFn, PIT)).toEqual({
      issuer: AUTH,
      authorizationEndpoint: `${AUTH}/authorize`,
      tokenEndpoint: `${AUTH}/token`,
      registrationEndpoint: `${AUTH}/register`,
      resource: PIT,
      scopesSupported: ["openid"],
    });
  });

  it("falls back to well-known metadata on the server's own origin", async () => {
    const { fetchFn } = oauthServer({
      [PIT]: () => new Response("", { status: 401 }),
      "https://api.agentpit.dev/.well-known/oauth-protected-resource/mcp": () => undefined,
      "https://api.agentpit.dev/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify({ authorization_endpoint: "https://api.agentpit.dev/a", token_endpoint: "https://api.agentpit.dev/t" })),
    });
    const found = await discoverAuthServer(fetchFn, PIT);
    expect([found.issuer, found.tokenEndpoint, found.resource]).toEqual(["https://api.agentpit.dev", "https://api.agentpit.dev/t", PIT]);
  });

  it("refuses a server without PKCE", async () => {
    const { fetchFn } = oauthServer({
      [`${AUTH}/.well-known/oauth-authorization-server`]: () =>
        new Response(JSON.stringify({ authorization_endpoint: "a", token_endpoint: "t", code_challenge_methods_supported: ["plain"] })),
    });
    await expect(discoverAuthServer(fetchFn, PIT)).rejects.toThrow("does not support PKCE");
  });
});

describe("starting a sign-in", () => {
  it("registers a client that returns to Clawbits and posts a PKCE authorization link", async () => {
    const { requests, client } = install();
    expect(await startMcpSignIn(client, "room_1", { server: "agentpit", url: PIT, scope: "openid offline_access" })).toBe(CONNECT);
    const registration = JSON.parse(server.seen.find((s) => s.url === `${AUTH}/register`)!.body) as Record<string, unknown>;
    expect(registration).toMatchObject({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none", scope: "openid offline_access" });
    const authorize = linked(requests);
    expect(authorize.origin + authorize.pathname).toBe(`${AUTH}/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: CALLBACK,
      code_challenge_method: "S256",
      resource: PIT,
      scope: "openid offline_access",
    });
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect((requests.at(-1) as unknown[])[2]).toMatchObject({ server: "agentpit", channel_id: "room_1" });
  });

  it("asks for the scopes the resource advertises when the agent names none", async () => {
    const { requests, client } = install();
    await startMcpSignIn(client, "room_1", { server: "agentpit", url: PIT });
    expect(linked(requests).searchParams.get("scope")).toBe("openid");
  });

  it("fails clearly on a server that allows no client registration", async () => {
    useServer({
      [`${AUTH}/.well-known/oauth-authorization-server`]: () =>
        new Response(JSON.stringify({ issuer: AUTH, authorization_endpoint: `${AUTH}/authorize`, token_endpoint: `${AUTH}/token` })),
    });
    const { client } = install();
    await expect(startMcpSignIn(client, "room_1", { server: "agentpit", url: PIT })).rejects.toThrow(
      "auth.agentpit.dev does not allow dynamic client registration",
    );
  });
});

describe("finishing a sign-in", () => {
  it("redeems the code with the verifier, saves the tokens as an auth profile, and points the server at it", async () => {
    const { config, requests, client } = install();
    await startMcpSignIn(client, "room_1", { server: "agentpit", url: PIT, scope: "openid offline_access" }, "/agents/main");
    const challenge = linked(requests).searchParams.get("code_challenge");
    requests.length = 0;

    expect(await finishMcpSignIn(signIn, client)).toBe(
      '[Clawbits] Signed in to MCP server "agentpit". Its tools are in your tool list from your next turn.',
    );
    const form = new URLSearchParams(server.seen.find((s) => s.url === `${AUTH}/token`)!.body);
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: CALLBACK,
      client_id: "client-1",
      resource: PIT,
    });
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(challenge!);
    expect(upsertedAuthProfiles).toHaveLength(1);
    expect(upsertedAuthProfiles[0]?.credential).not.toHaveProperty("issuer");
    expect(upsertedAuthProfiles[0]).toMatchObject({
      profileId: "clawbits-mcp:agentpit",
      agentDir: "/agents/main",
      credential: {
        type: "oauth",
        provider: MCP_AUTH_PROVIDER,
        access: "access-1",
        refresh: "refresh-1",
        clientId: "client-1",
        tokenEndpoint: `${AUTH}/token`,
        authorizationScope: "openid offline_access",
        grantedScope: "openid offline_access",
      },
    });
    expect(config.mcp?.servers?.agentpit).toEqual({
      url: PIT,
      transport: "streamable-http",
      auth: "oauth",
      oauth: { authProfileId: "clawbits-mcp:agentpit" },
    });
    expect(requests).toEqual([["POST", "/api/agentic/mcp-oauth/result", { state: "s1", connected: true }]]);
  });

  it("reports a refused code and keeps the sign-in for another try", async () => {
    let refuse = true;
    useServer({
      [`${AUTH}/token`]: () =>
        refuse
          ? new Response(JSON.stringify({ error: "invalid_grant", error_description: "code expired" }), { status: 400 })
          : new Response(JSON.stringify({ access_token: "a2" })),
    });
    const { requests, client } = install();
    await startMcpSignIn(client, "room_1", { server: "agentpit", url: PIT });
    requests.length = 0;
    expect(await finishMcpSignIn(signIn, client)).toBe(
      '[Clawbits] Sign-in to MCP server "agentpit" did not finish: invalid_grant: code expired. Its Connect card is open again for another try.',
    );
    expect(requests).toEqual([["POST", "/api/agentic/mcp-oauth/result", { state: "s1", connected: false }]]);
    refuse = false;
    expect(await finishMcpSignIn(signIn, client)).toContain("Signed in");
    expect(upsertedAuthProfiles[0]?.credential).toMatchObject({ access: "a2", refresh: "" });
  });

  it("fails a code no sign-in is waiting for", async () => {
    const { client } = install();
    expect(await finishMcpSignIn(signIn, client)).toContain("no sign-in is waiting for this server");
  });

  it("accepts only complete events", () => {
    expect(isMcpSignIn(signIn)).toBe(true);
    expect(isMcpSignIn({ ...signIn, human_id: "7" })).toBe(false);
    expect(isMcpSignIn(null)).toBe(false);
  });
});

describe("refreshing a saved sign-in", () => {
  it("registers the refresh provider OpenClaw calls for its profiles", () => {
    const { providers } = install();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: MCP_AUTH_PROVIDER, auth: [] });
  });

  it("trades the refresh token for new tokens with the client and resource it signed in with", async () => {
    const { client } = install();
    await startMcpSignIn(client, "room_1", { server: "agentpit", url: PIT });
    await finishMcpSignIn(signIn, client);
    useServer({ [`${AUTH}/token`]: () => new Response(JSON.stringify({ access_token: "access-2", expires_in: 60 })) });
    const saved = upsertedAuthProfiles[0]!.credential as Parameters<typeof refreshMcpCredential>[0];
    const refreshed = await refreshMcpCredential(saved);
    expect(refreshed).toMatchObject({ access: "access-2", refresh: "refresh-1", clientId: "client-1" });
    expect(refreshed.expires).toBeGreaterThan(Date.now());
    expect(Object.fromEntries(new URLSearchParams(server.seen.at(-1)!.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      resource: PIT,
      client_id: "client-1",
    });
  });

  it("asks for a new sign-in when there is no refresh token", async () => {
    install();
    await expect(
      refreshMcpCredential({ type: "oauth", provider: MCP_AUTH_PROVIDER, access: "a", refresh: "", expires: 0 }),
    ).rejects.toThrow("connect the server again");
  });
});

describe("a bare login in a Clawbits chat", () => {
  it("is steered to the connect tool, also when the host names no requester", () => {
    const { before } = install();
    expect(before("openclaw mcp login agentpit")?.blockReason).toContain("clawbits_mcp_connect");
    expect(before("openclaw mcp set agentpit '{}' && openclaw mcp login agentpit", undefined)?.block).toBe(true);
  });

  it("is left alone for code exchanges, other channels and other commands", () => {
    const { before } = install();
    expect(before("openclaw mcp login agentpit --code abc")).toBeUndefined();
    expect(before("openclaw mcp login agentpit", { channel: "telegram" })).toBeUndefined();
    expect(before("openclaw mcp list")).toBeUndefined();
  });
});

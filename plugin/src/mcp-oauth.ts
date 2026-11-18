import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import { CHANNEL_ID } from "./accounts.js";
import { type ClawBitsClient, timedRequest } from "./client.js";
import { logWarn } from "./file-logger.js";
import {
  authorizationUrl,
  discoverAuthServer,
  exchangeCode,
  type Fetch,
  pkce,
  refreshTokens,
  registerClient,
  type TokenClient,
} from "./mcp-oauth-client.js";
import { type KeyedStore, pluginRuntime } from "./runtime.js";

/** Clawbits signs agents in to OAuth MCP servers itself and keeps the tokens in an OpenClaw auth profile
 *  the server's `oauth.authProfileId` names; OpenClaw sends the profile's token on each request and calls
 *  this provider's `refreshOAuth` when it expires. The `openclaw mcp login` CLI cannot run here: since
 *  OpenClaw 2026.10.10 it refuses while the gateway that runs this plugin owns the state. */
export const MCP_AUTH_PROVIDER = "clawbits-mcp";

export interface McpSignIn {
  server: string;
  code: string;
  state: string;
  channel_id: string;
  human_id: number;
}

export interface McpConnect {
  server: string;
  url: string;
  scope?: string;
}

/** A sign-in the agent started and the human has yet to finish, keyed by server name. */
interface PendingSignIn extends TokenClient {
  url: string;
  redirectUri: string;
  verifier: string;
  scope?: string;
  agentDir?: string;
}

/** What a refresh needs that an auth profile has no field for, keyed by client id. The profile leaves out
 *  `issuer`: with it and `clientId`, OpenClaw takes a refresh for a different account unless an `accountId`
 *  matches, and an MCP sign-in has none. */
interface ClientExtras {
  resource: string;
  clientSecret?: string;
  authMethod: string;
}

interface McpOAuthCredential {
  type: "oauth";
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  clientId?: string;
  tokenEndpoint?: string;
  authorizationScope?: string;
  grantedScope?: string;
}

type UpsertAuthProfile = (params: { profileId: string; credential: McpOAuthCredential; agentDir?: string }) => unknown;

const LOGIN = /\bopenclaw\s+mcp\s+login\b(?![^;&|\n]*--code)/;
const REQUEST_TIMEOUT_MS = 10_000;
const PENDING_TTL_MS = 60 * 60_000;
const fetchFn: Fetch = (input, init) => fetch(input, init);

let pendingStore: KeyedStore<PendingSignIn> | undefined;
let extrasStore: KeyedStore<ClientExtras> | undefined;
const pending = (): KeyedStore<PendingSignIn> | undefined =>
  (pendingStore ??= pluginRuntime()?.state.openKeyedStore<PendingSignIn>({
    namespace: "mcp-sign-ins",
    maxEntries: 200,
    defaultTtlMs: PENDING_TTL_MS,
  }));
const clientExtras = (): KeyedStore<ClientExtras> | undefined =>
  (extrasStore ??= pluginRuntime()?.state.openKeyedStore<ClientExtras>({ namespace: "mcp-clients", maxEntries: 500 }));

/** Test seam: drop the stores opened against a previous runtime. */
export function resetMcpOAuthStores(): void {
  pendingStore = undefined;
  extrasStore = undefined;
}

export const mcpAuthProfileId = (server: string): string => `${MCP_AUTH_PROVIDER}:${server}`;

export function isMcpSignIn(data: unknown): data is McpSignIn {
  const signIn = data as Partial<McpSignIn> | null;
  return [signIn?.server, signIn?.code, signIn?.state].every((v) => typeof v === "string") && typeof signIn?.human_id === "number";
}

const request = <T>(client: ClawBitsClient, method: string, path: string, json?: unknown) =>
  timedRequest<T>(client, path, method, path, { json, timeoutMs: REQUEST_TIMEOUT_MS });

/** Discover `url`'s authorization server, register a client that returns to Clawbits, and hold the PKCE
 *  verifier until the code comes back. Returns the connect link to post for the human. */
export async function startMcpSignIn(
  client: ClawBitsClient,
  channelId: string,
  { server, url, scope }: McpConnect,
  agentDir?: string,
): Promise<string> {
  const store = pending();
  if (!store) throw new Error("The Clawbits channel is not running.");
  const { url: redirectUri } = await request<{ url: string }>(client, "GET", "/api/agentic/mcp-oauth/redirect");
  const auth = await discoverAuthServer(fetchFn, url);
  const wanted = scope ?? auth.scopesSupported?.join(" ");
  const registered = await registerClient(fetchFn, auth, redirectUri, wanted);
  const { verifier, challenge } = pkce();
  await store.register(server, {
    url,
    redirectUri,
    verifier,
    tokenEndpoint: auth.tokenEndpoint,
    resource: auth.resource,
    ...registered,
    ...(wanted ? { scope: wanted } : {}),
    ...(agentDir ? { agentDir } : {}),
  });
  const authorize = authorizationUrl(auth, registered, { redirectUri, challenge, ...(wanted ? { scope: wanted } : {}) });
  const link = { server, url: authorize, channel_id: channelId };
  return (await request<{ url: string }>(client, "POST", "/api/agentic/mcp-oauth/links", link)).url;
}

function upsertProfile(): UpsertAuthProfile {
  const sdk = providerAuth as unknown as { upsertAuthProfileAsync?: UpsertAuthProfile; upsertAuthProfile: UpsertAuthProfile };
  return sdk.upsertAuthProfileAsync ?? sdk.upsertAuthProfile;
}

/** Redeem the code, save the tokens as the server's auth profile and point the server at it. */
async function redeem(server: string, code: string): Promise<void> {
  const store = pending();
  const signIn = await store?.lookup(server);
  if (!signIn) throw new Error("no sign-in is waiting for this server; connect it again");
  const tokens = await exchangeCode(fetchFn, signIn, { code, verifier: signIn.verifier, redirectUri: signIn.redirectUri });
  const extras: ClientExtras = {
    resource: signIn.resource ?? signIn.url,
    authMethod: signIn.authMethod,
    ...(signIn.clientSecret ? { clientSecret: signIn.clientSecret } : {}),
  };
  await clientExtras()?.register(signIn.clientId, extras);
  const profileId = mcpAuthProfileId(server);
  await upsertProfile()({
    profileId,
    credential: {
      type: "oauth",
      provider: MCP_AUTH_PROVIDER,
      access: tokens.access,
      refresh: tokens.refresh ?? "",
      expires: tokens.expires,
      clientId: signIn.clientId,
      tokenEndpoint: signIn.tokenEndpoint,
      ...(signIn.scope ? { authorizationScope: signIn.scope } : {}),
      ...(tokens.scope ? { grantedScope: tokens.scope } : {}),
    },
    ...(signIn.agentDir ? { agentDir: signIn.agentDir } : {}),
  });
  const rt = pluginRuntime();
  if (!rt) throw new Error("the gateway was not ready");
  await rt.config.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const servers = ((draft.mcp ??= {}).servers ??= {});
      const prev = servers[server];
      servers[server] = {
        ...prev,
        url: signIn.url,
        transport: prev?.transport === "sse" ? "sse" : "streamable-http",
        auth: "oauth",
        oauth: { authProfileId: profileId },
      };
    },
  });
  await store?.delete(server);
}

/** Finish a sign-in the human completed, report it, and tell the agent the outcome. */
export async function finishMcpSignIn({ server, code, state }: McpSignIn, client: ClawBitsClient): Promise<string> {
  let reason: string | undefined;
  try {
    await redeem(server, code);
  } catch (err) {
    reason = String((err as Error)?.message ?? err);
  }
  await request(client, "POST", "/api/agentic/mcp-oauth/result", { state, connected: reason === undefined }).catch((err: unknown) =>
    logWarn(undefined, `[clawbits] mcp-oauth result failed: ${String((err as Error)?.message ?? err)}`),
  );
  return reason === undefined
    ? `[Clawbits] Signed in to MCP server "${server}". Its tools are in your tool list from your next turn.`
    : `[Clawbits] Sign-in to MCP server "${server}" did not finish: ${reason}. Its Connect card is open again for another try.`;
}

/** OpenClaw's refresh hook for the profiles `redeem` saves. */
export async function refreshMcpCredential(cred: McpOAuthCredential): Promise<McpOAuthCredential> {
  if (!cred.refresh || !cred.clientId || !cred.tokenEndpoint) {
    throw new Error("This MCP sign-in has expired and cannot be renewed; connect the server again.");
  }
  const extras = await clientExtras()?.lookup(cred.clientId);
  const tokens = await refreshTokens(
    fetchFn,
    {
      clientId: cred.clientId,
      tokenEndpoint: cred.tokenEndpoint,
      authMethod: extras?.authMethod ?? "none",
      ...(extras?.clientSecret ? { clientSecret: extras.clientSecret } : {}),
      ...(extras?.resource ? { resource: extras.resource } : {}),
    },
    cred.refresh,
  );
  return {
    ...cred,
    access: tokens.access,
    refresh: tokens.refresh ?? cred.refresh,
    expires: tokens.expires,
    ...(tokens.scope ? { grantedScope: tokens.scope } : {}),
  };
}

export function registerMcpAuthProvider(api: OpenClawPluginApi): void {
  (api.registerProvider as unknown as ((provider: unknown) => void) | undefined)?.({
    id: MCP_AUTH_PROVIDER,
    label: "Clawbits MCP sign-in",
    auth: [],
    refreshOAuth: (cred: McpOAuthCredential) => refreshMcpCredential(cred),
  });
}

/** In Clawbits chats, MCP sign-in goes through `clawbits_mcp_connect`; a bare login's localhost callback never reaches the agent. Blocks unless the turn provably came from another channel. */
export function registerMcpLoginGuard(api: OpenClawPluginApi): void {
  api.on?.(
    "before_tool_call",
    (event, ctx) =>
      (ctx.requester?.channel ?? CHANNEL_ID) === CHANNEL_ID &&
      typeof event.params.command === "string" &&
      LOGIN.test(event.params.command)
        ? { block: true, blockReason: "In Clawbits, sign in to MCP servers with the clawbits_mcp_connect tool." }
        : undefined,
    { matcher: ["exec"] },
  );
}

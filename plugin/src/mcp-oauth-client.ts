import { createHash, randomBytes } from "node:crypto";

/** OAuth for a remote MCP server, per the MCP authorization spec: protected-resource and
 *  authorization-server discovery, dynamic client registration, PKCE, and token requests. */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface McpAuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** RFC 8707 resource the tokens are for. */
  resource: string;
  /** Scopes the resource advertises, for when the caller names none. */
  scopesSupported?: string[];
}

export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
  /** `none`, `client_secret_post` or `client_secret_basic`. */
  authMethod: string;
}

export interface TokenClient extends McpOAuthClient {
  tokenEndpoint: string;
  resource?: string;
}

export interface TokenSet {
  access: string;
  refresh?: string;
  /** Epoch ms. */
  expires: number;
  scope?: string;
}

const TIMEOUT_MS = 10_000;
const DEFAULT_LIFETIME_S = 3_600;
const RESOURCE_METADATA = /resource_metadata="([^"]+)"/;

async function getJson(fetchFn: Fetch, url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : undefined;
const trimSlash = (path: string): string => (path === "/" ? "" : path.replace(/\/$/, ""));

/** The resource-metadata URL a 401 from the server names, if it names one. */
async function challengedMetadataUrl(fetchFn: Fetch, url: string): Promise<string | undefined> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "clawbits", version: "1" } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return RESOURCE_METADATA.exec(res.headers.get("www-authenticate") ?? "")?.[1];
  } catch {
    return undefined;
  }
}

/** Where the MCP server at `url` sends clients to sign in. */
export async function discoverAuthServer(fetchFn: Fetch, url: string): Promise<McpAuthServer> {
  const target = new URL(url);
  target.hash = "";
  const path = trimSlash(target.pathname);
  const challenged = await challengedMetadataUrl(fetchFn, target.href);
  let resource: Record<string, unknown> | undefined;
  for (const candidate of [
    challenged,
    `${target.origin}/.well-known/oauth-protected-resource${path}`,
    `${target.origin}/.well-known/oauth-protected-resource`,
  ]) {
    if (candidate && (resource = await getJson(fetchFn, candidate))) break;
  }
  const issuer = str(strings(resource?.authorization_servers)?.[0]) ?? target.origin;
  const issuerUrl = new URL(issuer);
  const issuerPath = trimSlash(issuerUrl.pathname);
  const candidates = issuerPath
    ? [
        `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
        `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
        `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`,
      ]
    : [`${issuerUrl.origin}/.well-known/oauth-authorization-server`, `${issuerUrl.origin}/.well-known/openid-configuration`];
  let meta: Record<string, unknown> | undefined;
  for (const candidate of candidates) if ((meta = await getJson(fetchFn, candidate))) break;
  const authorizationEndpoint = str(meta?.authorization_endpoint);
  const tokenEndpoint = str(meta?.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error(`${target.host} publishes no OAuth authorization server metadata`);
  }
  const methods = strings(meta?.code_challenge_methods_supported);
  if (methods && !methods.includes("S256")) throw new Error(`${issuerUrl.host} does not support PKCE (S256)`);
  const registrationEndpoint = str(meta?.registration_endpoint);
  const scopesSupported = strings(resource?.scopes_supported);
  return {
    issuer: str(meta?.issuer) ?? issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    resource: str(resource?.resource) ?? target.href,
    ...(scopesSupported?.length ? { scopesSupported } : {}),
  };
}

/** RFC 7591 registration of a public client that returns to `redirectUri`. */
export async function registerClient(
  fetchFn: Fetch,
  server: McpAuthServer,
  redirectUri: string,
  scope?: string,
): Promise<McpOAuthClient> {
  if (!server.registrationEndpoint) {
    throw new Error(`${new URL(server.issuer).host} does not allow dynamic client registration`);
  }
  const res = await fetchFn(server.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Clawbits",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope ? { scope } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const clientId = str(body.client_id);
  if (!res.ok || !clientId) throw new Error(`client registration failed: ${oauthError(body, res.status)}`);
  const clientSecret = str(body.client_secret);
  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    authMethod: str(body.token_endpoint_auth_method) ?? (clientSecret ? "client_secret_basic" : "none"),
  };
}

const base64url = (buf: Buffer): string => buf.toString("base64url");

export function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

export function authorizationUrl(
  server: McpAuthServer,
  client: McpOAuthClient,
  params: { redirectUri: string; challenge: string; scope?: string },
): string {
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", base64url(randomBytes(16)));
  url.searchParams.set("resource", server.resource);
  if (params.scope) url.searchParams.set("scope", params.scope);
  return url.href;
}

function oauthError(body: Record<string, unknown>, status: number): string {
  const error = str(body.error);
  const description = str(body.error_description);
  return error ? (description ? `${error}: ${description}` : error) : `HTTP ${String(status)}`;
}

async function tokenRequest(fetchFn: Fetch, client: TokenClient, grant: Record<string, string>): Promise<TokenSet> {
  const form = new URLSearchParams({ ...grant, ...(client.resource ? { resource: client.resource } : {}) });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (client.clientSecret && client.authMethod === "client_secret_basic") {
    const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  } else {
    form.set("client_id", client.clientId);
    if (client.clientSecret) form.set("client_secret", client.clientSecret);
  }
  const res = await fetchFn(client.tokenEndpoint, {
    method: "POST",
    headers,
    body: form.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const access = str(body.access_token);
  if (!res.ok || !access) throw new Error(oauthError(body, res.status));
  const refresh = str(body.refresh_token);
  const scope = str(body.scope);
  const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : DEFAULT_LIFETIME_S;
  return {
    access,
    ...(refresh ? { refresh } : {}),
    expires: Date.now() + lifetime * 1_000,
    ...(scope ? { scope } : {}),
  };
}

export function exchangeCode(
  fetchFn: Fetch,
  client: TokenClient,
  params: { code: string; verifier: string; redirectUri: string },
): Promise<TokenSet> {
  return tokenRequest(fetchFn, client, {
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.verifier,
    redirect_uri: params.redirectUri,
  });
}

export function refreshTokens(fetchFn: Fetch, client: TokenClient, refresh: string, scope?: string): Promise<TokenSet> {
  return tokenRequest(fetchFn, client, {
    grant_type: "refresh_token",
    refresh_token: refresh,
    ...(scope ? { scope } : {}),
  });
}

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CHANNEL_ID, DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { type ClawBitsClient, timedRequest } from "./client.js";
import { logWarn } from "./file-logger.js";

type McpServers = NonNullable<NonNullable<OpenClawConfig["mcp"]>["servers"]>;

export interface McpSignIn {
  server: string;
  code: string;
  state: string;
  channel_id: string;
  human_id: number;
}

const LOGIN = /\bopenclaw\s+mcp\s+login\s+(?![^;&|\n]*--code)(["']?)(\w[\w.-]*)\1/g;
const CLI_TIMEOUT_MS = 4_000;
const EXCHANGE_TIMEOUT_MS = 20_000;

const accounts = new Map<string, { callback: string; client: ClawBitsClient }>();
let runtime: OpenClawPluginApi["runtime"] | undefined;

export function setMcpOAuthCallback(accountId: string, snapshot: unknown, client: ClawBitsClient): void {
  const callback = (snapshot as { mcp_oauth_redirect_url?: unknown } | null)?.mcp_oauth_redirect_url;
  if (typeof callback === "string") accounts.set(accountId, { callback, client });
  else accounts.delete(accountId);
}

export function isMcpSignIn(data: unknown): data is McpSignIn {
  const signIn = data as Partial<McpSignIn> | null;
  return [signIn?.server, signIn?.code, signIn?.state].every((v) => typeof v === "string") && typeof signIn?.human_id === "number";
}

const mcpServers = (): McpServers => (runtime?.config.current() as OpenClawConfig | undefined)?.mcp?.servers ?? {};

const accountFor = (requester?: { channel?: string; accountId?: string }) =>
  requester?.channel === CHANNEL_ID ? accounts.get(requester.accountId ?? DEFAULT_ACCOUNT_ID) : undefined;

const logins = (command: unknown): string[] =>
  typeof command === "string" ? [...command.matchAll(LOGIN)].map(([, , name]) => name) : [];

async function openclaw(timeoutMs: number, ...args: string[]): Promise<boolean> {
  if (!runtime) return false;
  const result = await runtime.system.runCommandWithTimeout([process.execPath, process.argv[1], ...args], { timeoutMs });
  if (result.code !== 0) logWarn(undefined, `[clawbits] openclaw ${args[0]} ${args[1]} failed: ${result.stderr}${result.stdout}`);
  return result.code === 0;
}

const post = (client: ClawBitsClient, path: string, json: unknown) =>
  timedRequest(client, path, "POST", path, { json, timeoutMs: 5_000 }).catch((err: unknown) =>
    logWarn(undefined, `[clawbits] ${path} failed: ${String((err as Error)?.message ?? err)}`),
  );

/** Point a server at Clawbits before the agent's `openclaw mcp login`, then register the link it prints. */
export function registerMcpOAuth(api: OpenClawPluginApi): void {
  runtime = api.runtime;
  api.on?.(
    "before_tool_call",
    async (event, ctx) => {
      const account = event.toolKind ? undefined : accountFor(ctx.requester);
      if (!account) return;
      for (const name of logins(event.params.command)) {
        const redirect = `${account.callback}/${name}`;
        const oauth = mcpServers()[name]?.oauth;
        if (oauth?.identity === "per-requester" || oauth?.redirectUrl === redirect) continue;
        if (
          (await openclaw(CLI_TIMEOUT_MS, "mcp", "logout", name)) &&
          (await openclaw(CLI_TIMEOUT_MS, "mcp", "configure", name, "--oauth-redirect-url", redirect))
        ) {
          continue;
        }
        return {
          block: true,
          blockReason: name in mcpServers()
            ? `Could not prepare MCP server "${name}" for sign-in. Run openclaw mcp login ${name} again.`
            : `Add MCP server "${name}" first, then run openclaw mcp login ${name} as its own command.`,
        };
      }
    },
    { matcher: ["exec"] },
  );
  api.on?.(
    "after_tool_call",
    async (event) => {
      if (logins(event.params.command).length === 0) return;
      for (const url of JSON.stringify(event.result ?? "").match(/https?:\/\/[^\s"'\\<>]+/g) ?? []) {
        const redirect = URL.parse(url)?.searchParams.get("redirect_uri") ?? "";
        const account = [...accounts.values()].find(({ callback }) => redirect.startsWith(`${callback}/`));
        if (account) await post(account.client, "/api/agentic/mcp-oauth/links", { url });
      }
    },
    { matcher: ["exec"] },
  );
}

/** Redeem a relayed code with the engine's own CLI, which holds the PKCE verifier; report and describe the outcome. */
export async function finishMcpSignIn({ server, code, state }: McpSignIn, client: ClawBitsClient): Promise<string> {
  const connected = await openclaw(EXCHANGE_TIMEOUT_MS, "mcp", "login", server, `--code=${code}`).catch(() => false);
  await post(client, "/api/agentic/mcp-oauth/result", { state, connected });
  return connected
    ? `[Clawbits] Signed in to MCP server "${server}". If its tools are missing on this turn, they load on the next message.`
    : `[Clawbits] Sign-in to MCP server "${server}" failed. Run openclaw mcp login ${server} for a new link.`;
}

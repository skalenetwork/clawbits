import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CHANNEL_ID } from "./accounts.js";
import { type ClawBitsClient, timedRequest } from "./client.js";
import { logWarn } from "./file-logger.js";

type Runtime = OpenClawPluginApi["runtime"];

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

interface McpRun {
  ok: boolean;
  stdout: string;
  reason: string;
}

interface McpProbe {
  servers?: Record<string, { tools?: number }>;
  diagnostics?: { message?: string }[];
  error?: { message?: string };
}

const LOGIN = /\bopenclaw\s+mcp\s+login\b(?![^;&|\n]*--code)/;
const AUTHORIZE = /^Open this URL to authorize .*\n(https:\/\/\S+)\n/m;
const REASON = /^\[openclaw\] Reason: (.+)$/m;
const SIGNED_IN = /^MCP OAuth credentials saved for /m;
/** The CLI snapshots the state database before it runs, and gives up while the gateway is writing it mid-turn; it says to retry. */
const DATABASE_BUSY = /did not stabilize|database is locked/;
const BUSY_ATTEMPTS = 3;
const BUSY_WAIT_MS = 1_000;
const CLI_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

let runtime: Runtime | undefined;

export function isMcpSignIn(data: unknown): data is McpSignIn {
  const signIn = data as Partial<McpSignIn> | null;
  return [signIn?.server, signIn?.code, signIn?.state].every((v) => typeof v === "string") && typeof signIn?.human_id === "number";
}

/** Run `openclaw mcp`, again while the state database is busy; with `until`, stop once stdout matches, as a login on a localhost redirect then waits for a callback that never reaches this VM. */
async function mcp(rt: Runtime, args: string[], until?: RegExp): Promise<McpRun> {
  for (let attempt = 1; ; attempt += 1) {
    const run = await mcpOnce(rt, args, until);
    if (run.ok || attempt === BUSY_ATTEMPTS || !DATABASE_BUSY.test(run.reason)) return run;
    await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
  }
}

async function mcpOnce(rt: Runtime, args: string[], until?: RegExp): Promise<McpRun> {
  let printed = "";
  try {
    const { code, stdout, stderr } = await rt.system.runCommandWithTimeout(
      [process.execPath, process.argv[1], "mcp", ...args],
      {
        timeoutMs: CLI_TIMEOUT_MS,
        onOutputChunk: (chunk, stream) => stream !== "stdout" || !until?.test((printed += chunk.toString())),
      },
    );
    const lastLine = stderr.trim().split("\n").at(-1);
    return {
      ok: code === 0 || Boolean(until?.test(stdout)),
      stdout,
      reason: REASON.exec(`${stderr}\n${stdout}`)?.[1] ?? (lastLine || `exit code ${String(code)}`),
    };
  } catch (err) {
    return { ok: false, stdout: "", reason: String((err as Error)?.message ?? err) };
  }
}

const request = <T>(client: ClawBitsClient, method: string, path: string, json?: unknown) =>
  timedRequest<T>(client, path, method, path, { json, timeoutMs: REQUEST_TIMEOUT_MS });

/** Point `server` at `url` with Clawbits as its OAuth redirect, then start its login: the connect link for the human, or null when it is signed in already.
 *  A server that returned elsewhere before is logged out first, dropping the client it registered for that redirect. */
export async function connectMcpServer(
  rt: Runtime,
  client: ClawBitsClient,
  channelId: string,
  { server, url, scope }: McpConnect,
): Promise<string | null> {
  const { url: redirectUrl } = await request<{ url: string }>(client, "GET", "/api/agentic/mcp-oauth/redirect");
  let moved = false;
  await rt.config.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const servers = ((draft.mcp ??= {}).servers ??= {});
      const prev = servers[server];
      moved = prev !== undefined && prev.oauth?.redirectUrl !== redirectUrl;
      servers[server] = {
        ...prev,
        url,
        transport: prev?.transport === "sse" ? "sse" : "streamable-http",
        auth: "oauth",
        oauth: { ...prev?.oauth, redirectUrl, ...(scope ? { scope } : {}) },
      };
    },
  });
  if (moved) await mcp(rt, ["logout", server]);
  const login = await mcp(rt, ["login", server], AUTHORIZE);
  if (!login.ok) throw new Error(`openclaw mcp login ${server} failed: ${login.reason}`);
  const authorize = AUTHORIZE.exec(login.stdout)?.[1];
  if (!authorize && SIGNED_IN.test(login.stdout)) return null;
  if (!authorize) throw new Error(`openclaw mcp login ${server} printed no authorization URL: ${login.reason}`);
  const link = { server, url: authorize, channel_id: channelId };
  return (await request<{ url: string }>(client, "POST", "/api/agentic/mcp-oauth/links", link)).url;
}

export function setMcpOAuthRuntime(rt: Runtime): void {
  runtime = rt;
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

/** What a live probe of `server` found: how many tools it serves, or why it did not start. */
async function probe(rt: Runtime, server: string): Promise<string> {
  const run = await mcp(rt, ["probe", server, "--json"]);
  let report: McpProbe | undefined;
  try {
    report = JSON.parse(run.stdout) as McpProbe;
  } catch {
    report = undefined;
  }
  const tools = report?.servers?.[server]?.tools;
  return run.ok && tools !== undefined
    ? `; it serves ${String(tools)} tools, in your tool list by the next turn at the latest.`
    : `, but it did not start: ${report?.diagnostics?.[0]?.message ?? report?.error?.message ?? run.reason}. Check its url and transport with openclaw mcp, then probe it.`;
}

/** Redeem a relayed code with the engine's own CLI, which holds the PKCE verifier; report it, then tell the agent whether the server works. */
export async function finishMcpSignIn({ server, code, state }: McpSignIn, client: ClawBitsClient): Promise<string> {
  const exchange = runtime ? await mcp(runtime, ["login", server, `--code=${code}`]) : undefined;
  const connected = exchange?.ok === true;
  await request(client, "POST", "/api/agentic/mcp-oauth/result", { state, connected }).catch((err: unknown) =>
    logWarn(undefined, `[clawbits] mcp-oauth result failed: ${String((err as Error)?.message ?? err)}`),
  );
  return runtime && connected
    ? `[Clawbits] Signed in to MCP server "${server}"${await probe(runtime, server)}`
    : `[Clawbits] Sign-in to MCP server "${server}" did not finish: ${exchange?.reason ?? "the gateway was not ready"}. Its Connect card is open again for another try.`;
}

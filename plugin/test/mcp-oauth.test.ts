import { describe, expect, it } from "bun:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ClawBitsClient } from "../src/client.js";
import { connectMcpServer, finishMcpSignIn, isMcpSignIn, registerMcpLoginGuard, setMcpOAuthRuntime } from "../src/mcp-oauth.js";

const CALLBACK = "https://app.clawbits.ai/oauth/mcp/callback";
const AUTHORIZE = `https://auth.example.com/authorize?state=s1&redirect_uri=${encodeURIComponent(CALLBACK)}`;
const CONNECT = "https://app.clawbits.ai/connect/link_1";
const PIT = "https://api.agentpit.dev/mcp";

type Hook = (event: unknown, ctx: unknown) => { block?: boolean; blockReason?: string } | undefined;

interface Cli {
  code?: number;
  stdout?: string;
  stderr?: string;
}

/** A gateway runtime whose `openclaw mcp` answers per verb, and a Clawbits client that records its requests. */
function install(servers: Record<string, unknown>, answer: (args: string[]) => Cli = () => ({})) {
  const config = { mcp: { servers } } as OpenClawConfig;
  const calls: string[][] = [];
  const stops: string[][] = [];
  const requests: unknown[] = [];
  const hooks = new Map<string, Hook>();
  const runtime = {
    config: {
      mutateConfigFile: async ({ mutate }: { mutate: (draft: OpenClawConfig) => void }) => {
        mutate(config);
      },
    },
    system: {
      runCommandWithTimeout: async (argv: string[], opts: { onOutputChunk?: (chunk: Buffer, stream: string) => boolean }) => {
        const args = argv.slice(2);
        calls.push(args);
        const { code = 0, stdout = "", stderr = "" } = answer(args);
        const stopped = stdout !== "" && opts.onOutputChunk?.(Buffer.from(stdout), "stdout") === false;
        if (stopped) stops.push(args);
        return { code: stopped ? null : code, stdout, stderr };
      },
    },
  } as unknown as OpenClawPluginApi["runtime"];
  setMcpOAuthRuntime(runtime);
  registerMcpLoginGuard({ on: (name: string, fn: Hook) => hooks.set(name, fn) } as unknown as OpenClawPluginApi);
  const client = {
    request: async (method: string, path: string, opts: { json?: unknown }) => {
      requests.push([method, path, opts.json]);
      return { url: path.endsWith("/redirect") ? CALLBACK : CONNECT };
    },
  } as unknown as ClawBitsClient;
  const before = (command: string, requester: unknown = { channel: "clawbits" }) =>
    hooks.get("before_tool_call")!({ toolName: "exec", params: { command } }, { requester });
  return { config, calls, stops, requests, before, client, runtime };
}

const prints = (url: string) => ({ stdout: `Open this URL to authorize "server":\n${url}\nWaiting for the browser…\n` });
const loginPrints = ([, verb, , code]: string[]): Cli => (verb === "login" && !code ? prints(AUTHORIZE) : {});

describe("connecting a server", () => {
  it("points the server at Clawbits, logs out the client it registered elsewhere, and registers the printed link", async () => {
    const { config, calls, requests, client, runtime } = install(
      { agentpit: { url: PIT, auth: "oauth", oauth: { scope: "openid offline_access" } } },
      loginPrints,
    );
    expect(await connectMcpServer(runtime, client, "room_1", { server: "agentpit", url: PIT })).toBe(CONNECT);
    expect(config.mcp?.servers?.agentpit).toEqual({
      url: PIT,
      transport: "streamable-http",
      auth: "oauth",
      oauth: { scope: "openid offline_access", redirectUrl: CALLBACK },
    });
    expect(calls).toEqual([
      ["mcp", "logout", "agentpit"],
      ["mcp", "login", "agentpit"],
    ]);
    expect(requests.at(-1)).toEqual([
      "POST",
      "/api/agentic/mcp-oauth/links",
      { server: "agentpit", url: AUTHORIZE, channel_id: "room_1" },
    ]);
  });

  it("adds a new server with the scope asked for and keeps a server's explicit SSE", async () => {
    const { config, client, runtime } = install({ legacy: { url: "https://legacy.example/sse", transport: "sse" } }, loginPrints);
    await connectMcpServer(runtime, client, "room_1", { server: "linear", url: "https://mcp.linear.app/mcp", scope: "read" });
    await connectMcpServer(runtime, client, "room_1", { server: "legacy", url: "https://legacy.example/sse" });
    expect(config.mcp?.servers?.linear).toEqual({
      url: "https://mcp.linear.app/mcp",
      transport: "streamable-http",
      auth: "oauth",
      oauth: { redirectUrl: CALLBACK, scope: "read" },
    });
    expect(config.mcp?.servers?.legacy?.transport).toBe("sse");
  });

  it("keeps the sign-in of a server that already returns to Clawbits and posts no link for it", async () => {
    const linear = { url: "https://mcp.linear.app/mcp", auth: "oauth", oauth: { redirectUrl: CALLBACK } };
    const { calls, requests, client, runtime } = install({ linear }, () => ({ stdout: 'MCP OAuth credentials saved for "linear".\n' }));
    expect(await connectMcpServer(runtime, client, "room_1", { server: "linear", url: linear.url })).toBeNull();
    expect(calls).toEqual([["mcp", "login", "linear"]]);
    expect(requests.map((r) => (r as string[])[1])).toEqual(["/api/agentic/mcp-oauth/redirect"]);
  });

  it("fails when the login neither prints a link nor saves credentials", async () => {
    const { client, runtime } = install({}, () => ({ stdout: "Something else\n" }));
    await expect(connectMcpServer(runtime, client, "room_1", { server: "linear", url: "https://mcp.linear.app/mcp" })).rejects.toThrow(
      "openclaw mcp login linear printed no authorization URL",
    );
  });

  it("stops a login that waits on a localhost callback once it prints the link", async () => {
    const { stops, client, runtime } = install({}, (args) => ({ ...loginPrints(args), code: 1 }));
    expect(await connectMcpServer(runtime, client, "room_1", { server: "agentpit", url: PIT })).toBe(CONNECT);
    expect(stops).toEqual([["mcp", "login", "agentpit"]]);
  });

  it("runs the login again while the gateway is writing the state database", async () => {
    let busy = true;
    const { calls, client, runtime } = install({}, (args) => {
      if (!busy) return loginPrints(args);
      busy = false;
      return { code: 1, stderr: "[openclaw] Reason: SQLite source did not stabilize after 10 read-only inspection attempts\n" };
    });
    expect(await connectMcpServer(runtime, client, "room_1", { server: "agentpit", url: PIT })).toBe(CONNECT);
    expect(calls).toEqual([
      ["mcp", "login", "agentpit"],
      ["mcp", "login", "agentpit"],
    ]);
  });

  it("fails with the reason the CLI gave, not its whole output", async () => {
    const { client, runtime } = install({}, () => ({
      code: 1,
      stderr: "[config] warnings: plugins.entries.perplexity …\n[openclaw] The CLI command failed.\n[openclaw] Reason: database is locked\n",
    }));
    await expect(connectMcpServer(runtime, client, "room_1", { server: "agentpit", url: PIT })).rejects.toThrow(
      "openclaw mcp login agentpit failed: database is locked",
    );
  });
});

describe("a bare login in a Clawbits chat", () => {
  it("is steered to the connect tool, also when the host names no requester", () => {
    const { before } = install({});
    expect(before("openclaw mcp login agentpit")?.blockReason).toContain("clawbits_mcp_connect");
    expect(before("openclaw mcp set agentpit '{}' && openclaw mcp login agentpit", undefined)?.block).toBe(true);
  });

  it("is left alone for code exchanges, other channels and other commands", () => {
    const { before } = install({});
    expect(before("openclaw mcp login agentpit --code abc")).toBeUndefined();
    expect(before("openclaw mcp login agentpit", { channel: "telegram" })).toBeUndefined();
    expect(before("openclaw mcp list")).toBeUndefined();
  });
});

describe("finishing a sign-in", () => {
  const signIn = { server: "agentpit", code: "c1", state: "s1", channel_id: "room", human_id: 7 };
  const probe = (report: unknown, code = 0) => ({ code, stdout: JSON.stringify(report) });

  it("redeems the code, reports it, and tells the agent how many tools the server serves", async () => {
    const { calls, requests, client } = install({}, ([, verb]) =>
      verb === "probe" ? probe({ servers: { agentpit: { tools: 3 } }, diagnostics: [] }) : {},
    );
    expect(await finishMcpSignIn(signIn, client)).toBe(
      '[Clawbits] Signed in to MCP server "agentpit"; it serves 3 tools, in your tool list by the next turn at the latest.',
    );
    expect(calls).toEqual([
      ["mcp", "login", "agentpit", "--code=c1"],
      ["mcp", "probe", "agentpit", "--json"],
    ]);
    expect(requests).toEqual([["POST", "/api/agentic/mcp-oauth/result", { state: "s1", connected: true }]]);
  });

  it("says why a signed-in server did not start", async () => {
    const { client } = install({}, ([, verb]) =>
      verb === "probe"
        ? probe({ servers: {}, diagnostics: [{ serverName: "agentpit", message: "SSE error: Non-200 status code (405)" }] }, 1)
        : {},
    );
    expect(await finishMcpSignIn(signIn, client)).toContain("but it did not start: SSE error: Non-200 status code (405)");
  });

  it("reports a failed exchange with its reason, leaving the card open for another try", async () => {
    const { calls, requests, client } = install({}, () => ({ code: 1, stderr: "[openclaw] Reason: invalid_grant\n" }));
    expect(await finishMcpSignIn(signIn, client)).toBe(
      '[Clawbits] Sign-in to MCP server "agentpit" did not finish: invalid_grant. Its Connect card is open again for another try.',
    );
    expect(calls).toEqual([["mcp", "login", "agentpit", "--code=c1"]]);
    expect(requests).toEqual([["POST", "/api/agentic/mcp-oauth/result", { state: "s1", connected: false }]]);
  });

  it("still reports when the CLI cannot even start", async () => {
    const { requests, client, runtime } = install({});
    (runtime.system as { runCommandWithTimeout: unknown }).runCommandWithTimeout = async () => {
      throw new Error("spawn EAGAIN");
    };
    expect(await finishMcpSignIn(signIn, client)).toContain("did not finish: spawn EAGAIN");
    expect(requests).toEqual([["POST", "/api/agentic/mcp-oauth/result", { state: "s1", connected: false }]]);
  });

  it("accepts only complete events", () => {
    expect(isMcpSignIn(signIn)).toBe(true);
    expect(isMcpSignIn({ ...signIn, human_id: "7" })).toBe(false);
    expect(isMcpSignIn(null)).toBe(false);
  });
});

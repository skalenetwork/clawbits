import { describe, expect, it } from "bun:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ClawBitsClient } from "../src/client.js";
import { finishMcpSignIn, isMcpSignIn, registerMcpOAuth, setMcpOAuthCallback } from "../src/mcp-oauth.js";

const CALLBACK = "https://app.clawbits.ai/oauth/mcp/callback/agent_1";
const PIT = { url: "https://api.agentpit.dev/mcp", auth: "oauth" };
const CLAWBITS = { channel: "clawbits", accountId: "default" };

type Hook = (event: unknown, ctx: unknown) => Promise<{ block?: boolean; blockReason?: string } | undefined>;

function install(servers: Record<string, unknown>, exit = (_args: string[]) => 0) {
  const calls: string[][] = [];
  const posted: unknown[] = [];
  const hooks = new Map<string, Hook>();
  registerMcpOAuth({
    runtime: {
      config: { current: () => ({ mcp: { servers } }) },
      system: {
        runCommandWithTimeout: async (argv: string[]) => {
          const args = argv.slice(2);
          calls.push(args);
          return { code: exit(args), stdout: "", stderr: "" };
        },
      },
    },
    on: (name: string, fn: Hook) => hooks.set(name, fn),
  } as unknown as OpenClawPluginApi);
  const client = {
    request: async (_method: string, path: string, opts: { json: unknown }) => posted.push([path, opts.json]),
  } as unknown as ClawBitsClient;
  setMcpOAuthCallback("default", { mcp_oauth_redirect_url: CALLBACK }, client);
  const before = (command: string, requester: unknown = CLAWBITS, event = {}) =>
    hooks.get("before_tool_call")!({ toolName: "exec", params: { command }, ...event }, { toolName: "exec", requester });
  const after = (command: string, result: unknown) =>
    hooks.get("after_tool_call")!({ toolName: "exec", params: { command }, result }, { toolName: "exec" });
  return { calls, posted, before, after, client };
}

describe("before the agent's login", () => {
  it("drops any client registered elsewhere and points the server at its Clawbits callback", async () => {
    const { calls, before } = install({ agentpit: PIT });
    expect(await before("openclaw mcp login agentpit")).toBeUndefined();
    expect(calls).toEqual([
      ["mcp", "logout", "agentpit"],
      ["mcp", "configure", "agentpit", "--oauth-redirect-url", `${CALLBACK}/agentpit`],
    ]);
  });

  it("leaves a server that already returns to Clawbits alone", async () => {
    const { calls, before } = install({ agentpit: { ...PIT, oauth: { redirectUrl: `${CALLBACK}/agentpit` } } });
    await before("openclaw mcp login agentpit");
    expect(calls).toEqual([]);
  });

  it("asks for a separate login when the server is added in the same command", async () => {
    const { before } = install({}, () => 1);
    const verdict = await before(`openclaw mcp set agentpit '{"url":"x"}' && openclaw mcp login agentpit`);
    expect(verdict?.block).toBe(true);
    expect(verdict?.blockReason).toContain("openclaw mcp login agentpit as its own command");
  });

  it("asks for a retry when preparing a configured server fails", async () => {
    const { before } = install({ agentpit: PIT }, ([, verb]) => (verb === "configure" ? 1 : 0));
    expect((await before("openclaw mcp login agentpit"))?.blockReason).toContain("Run openclaw mcp login agentpit again");
  });

  it("ignores code exchanges, other channels, code-mode exec and other commands", async () => {
    const { calls, before } = install({ agentpit: PIT });
    await before("openclaw mcp login agentpit --code abc");
    await before("openclaw mcp login --code abc agentpit");
    await before("openclaw mcp login agentpit", { channel: "telegram", accountId: "default" });
    await before("openclaw mcp login agentpit", null);
    await before("openclaw mcp login agentpit", CLAWBITS, { toolKind: "code_mode_exec" });
    await before("openclaw mcp list");
    expect(calls).toEqual([]);
  });
});

describe("after the agent's login", () => {
  it("registers only the links that return to this agent's callback", async () => {
    const { posted, after } = install({ agentpit: PIT });
    const ours = `https://auth.example.com/authorize?state=s1&redirect_uri=${encodeURIComponent(`${CALLBACK}/agentpit`)}`;
    const loopback = `https://auth.example.com/authorize?state=s2&redirect_uri=${encodeURIComponent("http://127.0.0.1:8989/oauth/callback")}`;
    const result = { content: [{ type: "text", text: `Open this URL to authorize "agentpit":\n${ours}\n${loopback}` }] };
    await after("openclaw mcp login agentpit", result);
    await after("openclaw mcp list", result);
    expect(posted).toEqual([["/api/agentic/mcp-oauth/links", { url: ours }]]);
  });
});

describe("finishing a sign-in", () => {
  const signIn = { server: "agentpit", code: "c1", state: "s1", channel_id: "room", human_id: 7 };

  it("redeems the code with the engine CLI and reports success", async () => {
    const { calls, posted, client } = install({ agentpit: PIT });
    expect(await finishMcpSignIn(signIn, client)).toContain('Signed in to MCP server "agentpit"');
    expect(calls).toEqual([["mcp", "login", "agentpit", "--code=c1"]]);
    expect(posted).toEqual([["/api/agentic/mcp-oauth/result", { state: "s1", connected: true }]]);
  });

  it("reports a failed exchange and tells the agent to retry", async () => {
    const { posted, client } = install({ agentpit: PIT }, () => 1);
    expect(await finishMcpSignIn(signIn, client)).toContain("Run openclaw mcp login agentpit for a new link.");
    expect(posted).toEqual([["/api/agentic/mcp-oauth/result", { state: "s1", connected: false }]]);
  });

  it("accepts only complete events", () => {
    expect(isMcpSignIn(signIn)).toBe(true);
    expect(isMcpSignIn({ ...signIn, human_id: "7" })).toBe(false);
    expect(isMcpSignIn(null)).toBe(false);
  });
});

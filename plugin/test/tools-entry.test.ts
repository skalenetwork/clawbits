import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import toolsEntry, { CLAWBITS_TOOL_NAMES } from "../src/tools-entry.js";
import { summarizeChannels, summarizePosts } from "../src/tool-views.js";
import { resolveCompanionServiceActivation } from "../src/companion-services.js";
import {
  CLAWBITS_SERVICE_HANDOFF_CAPABILITY,
  registerSlimChannelHandoff,
} from "../src/service-handoff.js";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, unknown>;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const DEFAULT_ACCOUNT = {
  endpoint: "https://app.clawbits.test",
  orgId: "org-1",
  agentId: "agent-1",
  apiKey: "secret-key",
  channelId: "channel-1",
  knownAnswers: { "What is the capital of France?": "Paris" },
};

// The host keeps its hook handler map internal, so recover each hook's real
// handler type by instantiating the published `on` signature.
declare const registerHook: OpenClawPluginApi["on"];
type HookName = Parameters<typeof registerHook>[0];
type HookHandler<K extends HookName> = Parameters<typeof registerHook<K>>[1];
type HookHandlers = Map<HookName, HookHandler<HookName>[]>;

// `on` correlates its hook name and handler through one type parameter, a
// correlation TypeScript cannot carry through a shared store; the bucket under
// `hookName` only ever holds handlers registered under that same name.
function hookHandler<K extends HookName>(
  handlers: HookHandlers,
  hookName: K,
): HookHandler<K> | undefined {
  return handlers.get(hookName)?.[0] as HookHandler<K> | undefined;
}

type PluginRuntime = OpenClawPluginApi["runtime"];
type StubRuntime = Pick<PluginRuntime, "version"> & {
  channel: Pick<PluginRuntime["channel"], "runtimeContexts">;
};
type StubPluginApi = Pick<
  OpenClawPluginApi,
  "registrationMode" | "config" | "logger" | "registerTool" | "on"
> & { runtime: StubRuntime };

interface RegisteredTool {
  tool: AnyAgentTool;
  optional: boolean;
}

// The host builds the whole plugin api before calling `register`; the double
// implements only the seams the tools entry touches, and every implemented slot
// keeps the host's published type.
function asPluginApi(api: StubPluginApi): OpenClawPluginApi {
  return api as OpenClawPluginApi;
}

function agentTool(tool: Parameters<OpenClawPluginApi["registerTool"]>[0]): AnyAgentTool {
  assert.ok(typeof tool !== "function", "clawbits registers tool objects, not factories");
  return tool;
}

function runtimeWithHandoff(version?: string): StubRuntime {
  const contexts = new Map<string, unknown>();
  const runtime: StubRuntime = {
    version: "2026.6.33",
    channel: {
      runtimeContexts: {
        register({ channelId, capability, context }) {
          const key = `${channelId}:${capability}`;
          contexts.set(key, context);
          return { dispose: () => contexts.delete(key) };
        },
        get: <T = unknown>({ channelId, capability }: { channelId: string; capability: string }) =>
          contexts.get(`${channelId}:${capability}`) as T | undefined,
        watch: () => () => {},
      },
    },
  };
  if (version) registerSlimChannelHandoff(runtime, version);
  return runtime;
}

function pluginApi(
  section: Record<string, unknown>,
  opts: {
    registrationMode?: OpenClawPluginApi["registrationMode"];
    runtime?: StubRuntime;
  } = {},
): {
  api: StubPluginApi;
  tools: RegisteredTool[];
  hooks: HookName[];
  handlers: HookHandlers;
} {
  const tools: RegisteredTool[] = [];
  const hooks: HookName[] = [];
  const handlers: HookHandlers = new Map();
  const api: StubPluginApi = {
    registrationMode: opts.registrationMode ?? "tool-discovery",
    config: { channels: { clawbits: section } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runtime: opts.runtime ?? runtimeWithHandoff(),
    registerTool(tool, registration) {
      tools.push({ tool: agentTool(tool), optional: registration?.optional === true });
    },
    on(hookName, handler) {
      hooks.push(hookName);
      const existing = handlers.get(hookName) ?? [];
      existing.push(handler);
      handlers.set(hookName, existing);
    },
  };
  return { api, tools, hooks, handlers };
}

function configuredApi(): ReturnType<typeof pluginApi> {
  return pluginApi({ accounts: { default: { ...DEFAULT_ACCOUNT } } });
}

function registeredTools(api = configuredApi().api): RegisteredTool[] {
  const collected: RegisteredTool[] = [];
  const original = api.registerTool.bind(api);
  api.registerTool = (tool, opts) => {
    collected.push({ tool: agentTool(tool), optional: opts?.optional === true });
    original(tool, opts);
  };
  toolsEntry.register(asPluginApi(api));
  return collected;
}

function findTool(name: (typeof CLAWBITS_TOOL_NAMES)[number]): AnyAgentTool {
  const tool = registeredTools().find((candidate) => candidate.tool.name === name)?.tool;
  assert.ok(tool, `tool ${name}`);
  return tool;
}

async function executeTool(
  tool: AnyAgentTool,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await tool.execute("tool-call-1", params, signal);
  return result.details;
}

async function callWithMockedFetch(
  tool: AnyAgentTool,
  params: Record<string, unknown>,
  respond: (input: unknown, init?: RequestInit) => Response,
): Promise<{ result: unknown; init: RequestInit | undefined }> {
  const originalFetch = globalThis.fetch;
  let seenInit: RequestInit | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      seenInit = init;
      return respond(input, init);
    };
    return { result: await executeTool(tool, params), init: seenInit };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function challengeResponse(): Response {
  return jsonResponse({
    session_token: "session-1",
    challenge: "What is the capital of France?",
  });
}

describe("clawbits companion plugin", () => {
  it("registers stable optional tools matching cold manifest metadata", () => {
    const registrations = registeredTools();
    assert.equal(toolsEntry.id, "clawbits-tools");
    assert.deepEqual(
      registrations.map(({ tool }) => tool.name),
      [...CLAWBITS_TOOL_NAMES],
    );
    assert.ok(registrations.every(({ optional }) => optional));

    const manifest = readJson("../openclaw.tools.plugin.json") as {
      requiresPlugins?: string[];
      skills?: string[];
      contracts?: { tools?: string[] };
      toolMetadata?: Record<string, { optional?: boolean }>;
    };
    assert.deepEqual(manifest.requiresPlugins, ["clawbits"]);
    assert.deepEqual(manifest.skills, ["./skills"]);
    assert.deepEqual(manifest.contracts?.tools, [...CLAWBITS_TOOL_NAMES]);
    assert.deepEqual(Object.keys(manifest.toolMetadata ?? {}), [...CLAWBITS_TOOL_NAMES]);
    assert.ok(Object.values(manifest.toolMetadata ?? {}).every((tool) => tool.optional === true));
  });

  it("keeps every companion tool in the agent image's optional-tool allowlist", () => {
    // OpenClaw does not auto-allow optional plugin tools: one missing from
    // tools.alsoAllow ships invisible to the agent, which is how a working
    // tool surface still reads as "broken in production".
    const defaults = readJson("../../images/openclaw/defaults.json") as {
      tools?: { alsoAllow?: string[] };
    };
    for (const name of CLAWBITS_TOOL_NAMES) {
      assert.ok(defaults.tools?.alsoAllow?.includes(name), `${name} in image defaults.json`);
    }
  });

  it("publishes a separate mixed tools/services entry", () => {
    const pkg = readJson("../package.tools.json") as {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
      openclaw?: {
        id?: string;
        extensions?: string[];
        runtimeExtensions?: string[];
        skills?: string[];
      };
    };
    const channelPkg = readJson("../package.json") as { version?: string };
    assert.equal(pkg.name, "clawbits-openclaw-tools");
    assert.equal(
      pkg.version?.split(".").slice(0, 2).join("."),
      channelPkg.version?.split(".").slice(0, 2).join("."),
    );
    assert.equal(pkg.openclaw?.id, "clawbits-tools");
    assert.deepEqual(pkg.openclaw?.extensions, ["./dist/tools-entry.js"]);
    assert.deepEqual(pkg.openclaw?.runtimeExtensions, ["./dist/tools-entry.js"]);
    assert.deepEqual(pkg.openclaw?.skills, ["./skills"]);
    assert.ok(pkg.dependencies?.["typebox"]);
  });

  it("declares one consistent OpenClaw compatibility floor", () => {
    const pkg = readJson("../package.tools.json") as {
      peerDependencies?: Record<string, string>;
      openclaw?: {
        compat?: { pluginApi?: string; minGatewayVersion?: string };
        build?: { openclawVersion?: string };
      };
    };
    const floor = pkg.openclaw?.compat?.minGatewayVersion;
    const build = pkg.openclaw?.build?.openclawVersion;
    assert.ok(floor);
    assert.ok(build);
    assert.equal(pkg.openclaw?.compat?.pluginApi, `>=${floor}`);
    assert.equal(pkg.peerDependencies?.["openclaw"], `>=${floor}`);
    assert.ok(compareVersions(floor, build) <= 0);
  });

  it("registers services only in full runtime mode", () => {
    const discovery = pluginApi({}, { registrationMode: "tool-discovery" });
    toolsEntry.register(asPluginApi(discovery.api));
    assert.deepEqual(discovery.hooks, []);

    const full = pluginApi({}, { registrationMode: "full" });
    toolsEntry.register(asPluginApi(full.api));
    assert.ok(full.hooks.includes("gateway_start"));
    assert.ok(full.hooks.includes("gateway_stop"));
    assert.ok(full.hooks.includes("cron_changed"));
  });

  it("starts and stops the owner-gated lifecycle idempotently", async () => {
    const setup = pluginApi(
      { serviceOwner: "tools" },
      { registrationMode: "full", runtime: runtimeWithHandoff("0.17.0") },
    );
    toolsEntry.register(asPluginApi(setup.api));
    const start = hookHandler(setup.handlers, "gateway_start");
    const stop = hookHandler(setup.handlers, "gateway_stop");
    assert.ok(start);
    assert.ok(stop);
    const gatewayCtx = { config: setup.api.config };
    await start({ port: 0 }, gatewayCtx);
    await start({ port: 0 }, gatewayCtx);
    await stop({}, gatewayCtx);
    await stop({}, gatewayCtx);
  });

  it("fails closed until tools ownership and a compatible slim channel marker agree", () => {
    const channelOwned = pluginApi({ serviceOwner: "channel" });
    assert.deepEqual(resolveCompanionServiceActivation(channelOwned.api.config, channelOwned.api.runtime), {
      active: false,
      reason: "channel-owner",
    });

    const noMarker = pluginApi(
      { serviceOwner: "tools" },
      { runtime: runtimeWithHandoff() },
    );
    assert.equal(
      resolveCompanionServiceActivation(noMarker.api.config, noMarker.api.runtime).reason,
      "missing-slim-channel",
    );

    const oldChannel = pluginApi(
      { serviceOwner: "tools" },
      { runtime: runtimeWithHandoff("0.16.99") },
    );
    assert.equal(
      resolveCompanionServiceActivation(oldChannel.api.config, oldChannel.api.runtime).reason,
      "missing-slim-channel",
    );

    const malformed = pluginApi(
      { serviceOwner: "tools" },
      { runtime: runtimeWithHandoff("not-a-version") },
    );
    assert.equal(
      resolveCompanionServiceActivation(malformed.api.config, malformed.api.runtime).reason,
      "missing-slim-channel",
    );

    const ready = pluginApi(
      { serviceOwner: "tools" },
      { runtime: runtimeWithHandoff("0.17.0") },
    );
    assert.deepEqual(resolveCompanionServiceActivation(ready.api.config, ready.api.runtime), {
      active: true,
      reason: "active",
    });

    const invalid = pluginApi({ serviceOwner: "somewhere" });
    assert.equal(
      resolveCompanionServiceActivation(invalid.api.config, invalid.api.runtime).reason,
      "invalid-owner",
    );
  });

  it("uses channel account config without exposing its API key", async () => {
    const listTool = findTool("clawbits_channels_list");
    let authorization = "";
    const { result, init } = await callWithMockedFetch(listTool, {}, (_input, requestInit) => {
      authorization = new Headers(requestInit?.headers).get("Authorization") ?? "";
      return jsonResponse({ channels: [{ channel_id: "channel-1", name: "ops" }], total: 1 });
    });
    assert.deepEqual(result, [
      {
        channel_id: "channel-1",
        display_name: "ops",
        channel_type: undefined,
        private: undefined,
        unread_count: undefined,
        last_message_at: undefined,
        latest_post_id: undefined,
      },
    ]);
    assert.equal(authorization, "Bearer secret-key");
    assert.ok(!JSON.stringify(result).includes("secret-key"));
    assert.ok(init?.signal instanceof AbortSignal);
  });

  it("narrows dashboard payloads to what the model can act on", () => {
    // Server responses carry avatars, presigned urls, sidebar preview rows and
    // per-viewer pin/mute state. Every byte of it is tokens in a tool result.
    const [channel] = summarizeChannels({
      channels: [
        {
          channel_id: "c1",
          name: "ops",
          display_name: "Ops",
          channel_type: "public",
          unread_count: 3,
          muted: true,
          pinned: true,
          org_id: "org-1",
          last_message_text: "sidebar preview",
          last_message_author_avatar: { url: "https://cdn/avatar.png" },
          dm_peer_human_id: 7,
        },
      ],
    });
    assert.deepEqual(Object.keys(channel ?? {}), [
      "channel_id",
      "display_name",
      "channel_type",
      "private",
      "unread_count",
      "last_message_at",
      "latest_post_id",
      "dm_peer",
    ]);
    assert.equal(channel?.display_name, "Ops");
    assert.equal(channel?.dm_peer, "human:7");
    assert.equal(
      summarizeChannels([{ channel_id: "c1" }])[0]?.channel_id,
      "c1",
      "a bare array is not silently read as zero channels",
    );

    const [post] = summarizePosts({
      posts: [
        {
          post_id: 42,
          human_id: 7,
          poster_display_name: "Dmytro",
          message: "ship it",
          created_at: "2026-09-01T00:00:00Z",
          avatar: { url: "https://cdn/a.png" },
          trace_id: "t-1",
          link_preview: { title: "noise" },
          files: [
            {
              file_id: "f1",
              filename: "plan.pdf",
              content_type: "application/pdf",
              size_bytes: 10,
              download_url: "https://signed.example/plan.pdf",
            },
          ],
        },
      ],
    });
    assert.equal(post?.sender, "human:7");
    assert.equal(post?.status, undefined, "published is the norm and stays implicit");
    // A listing includes replies still being generated; they must not read as
    // finished messages.
    assert.equal(
      summarizePosts({ posts: [{ post_id: 1, status: "streaming" }] })[0]?.status,
      "streaming",
    );
    assert.equal(post?.sender_name, "Dmytro");
    assert.deepEqual(post?.files, [
      { file_id: "f1", filename: "plan.pdf", content_type: "application/pdf", size_bytes: 10 },
    ]);
    const rendered = JSON.stringify(post);
    for (const dropped of ["avatar", "trace_id", "link_preview", "signed.example"]) {
      assert.ok(!rendered.includes(dropped), `${dropped} dropped`);
    }
  });

  it("searches with the account channel as the server-side scope", async () => {
    const search = findTool("clawbits_search");
    let requested = "";
    const { result } = await callWithMockedFetch(
      search,
      { query: "migration decision", limit: 5 },
      (input) => {
        requested = String(input);
        return jsonResponse({
          scope: "all_channels",
          query: "migration decision",
          sort: "recent",
          next_cursor: null,
          results: [
            {
              post_id: 11358,
              channel_id: "channel-1",
              channel_display_name: "Ops",
              channel_type: "public",
              created_at: "2026-09-01T00:00:00Z",
              author: { kind: "human", human_id: 7, display_name: "Dmytro", avatar: {} },
              snippet: "the <mark>migration</mark> lands Friday &amp; freezes main",
              rank: 0.9,
            },
          ],
        });
      },
    );
    const query = new URL(requested).searchParams;
    assert.equal(query.get("context_channel_id"), "channel-1");
    assert.equal(query.get("q"), "migration decision");
    assert.equal(query.get("limit"), "5");
    assert.equal(query.get("cursor"), null, "absent params are not sent as empty");
    assert.deepEqual(result, {
      scope: "all_channels",
      results: [
        {
          post_id: 11358,
          channel_id: "channel-1",
          channel: "Ops",
          sender: "human:7",
          sender_name: "Dmytro",
          created_at: "2026-09-01T00:00:00Z",
          // <mark> and dashboard HTML escaping are stripped for the model.
          snippet: "the migration lands Friday & freezes main",
        },
      ],
    });
  });

  it("reads a channel's latest posts or a window around one", async () => {
    const posts = findTool("clawbits_channel_posts");
    const seen: string[] = [];
    const respond = (input: unknown) => {
      seen.push(String(input));
      return jsonResponse({ posts: [{ post_id: 9, agent_id: "agent-1", message: "on it" }] });
    };

    const latest = await callWithMockedFetch(posts, { channelId: "c9", limit: 10 }, respond);
    assert.deepEqual(latest.result, [
      { post_id: 9, sender: "agent:agent-1", created_at: undefined, message: "on it" },
    ]);

    await callWithMockedFetch(posts, { channelId: "c9", aroundPostId: 11358 }, respond);
    assert.ok(seen[0]?.endsWith("/api/agentic/mm/channels/c9/posts?limit=10"), seen[0]);
    assert.ok(
      seen[1]?.endsWith("/api/agentic/mm/channels/c9/posts/around/11358?radius=25"),
      seen[1],
    );
  });

  it("rejects a blank search query", async () => {
    await assert.rejects(
      () => executeTool(findTool("clawbits_search"), { query: "  " }),
      /must not be blank/,
    );
  });

  it("fails clearly when the channel account is missing", async () => {
    const setup = pluginApi({});
    const tools = registeredTools(setup.api);
    const info = tools.find(({ tool }) => tool.name === "clawbits_agent_info")?.tool;
    assert.ok(info);
    await assert.rejects(() => executeTool(info, {}), /channel plugin first/);
  });

  it("rejects an unknown account id instead of falling back", async () => {
    const setup = pluginApi({
      ...DEFAULT_ACCOUNT,
      accounts: { work: { ...DEFAULT_ACCOUNT, agentId: "agent-work" } },
    });
    const info = registeredTools(setup.api).find(
      ({ tool }) => tool.name === "clawbits_agent_info",
    )?.tool;
    assert.ok(info);
    await assert.rejects(() => executeTool(info, { accountId: "wrok" }), /Unknown Clawbits account/);
  });

  it("honors account and email kill switches", async () => {
    const disabled = pluginApi({ accounts: { default: { ...DEFAULT_ACCOUNT, enabled: false } } });
    const list = registeredTools(disabled.api).find(
      ({ tool }) => tool.name === "clawbits_channels_list",
    )?.tool;
    assert.ok(list);
    await assert.rejects(() => executeTool(list, {}), /disabled/);

    const noEmail = pluginApi({
      accounts: { default: { ...DEFAULT_ACCOUNT, emailEnabled: false } },
    });
    for (const name of ["clawbits_email_inbox", "clawbits_email_get", "clawbits_email_send"] as const) {
      const tool = registeredTools(noEmail.api).find(({ tool }) => tool.name === name)?.tool;
      assert.ok(tool);
      const params = name === "clawbits_email_get"
        ? { messageUid: 1 }
        : name === "clawbits_email_send"
          ? { subject: "x", message: "y" }
          : {};
      await assert.rejects(() => executeTool(tool, params), /email integration is disabled/);
    }
  });

  it("sends owner email through the companion tool", async () => {
    const send = findTool("clawbits_email_send");
    let body: unknown;
    const { result } = await callWithMockedFetch(
      send,
      { subject: "Status", message: "Done" },
      (input, init) => {
        const target = String(input);
        if (target.endsWith("/api/agentic/auth/challenge")) return challengeResponse();
        if (target.endsWith("/api/agentic/agents/agent-1/email/send")) {
          body = JSON.parse(String(init?.body));
          return jsonResponse({ status: "sent", subject: "Status" });
        }
        if (target.endsWith("/api/agentic/mm/channels/channel-1/posts")) {
          return jsonResponse({ post_id: "mirror-1" });
        }
        return new Response(`unexpected: ${target}`, { status: 500 });
      },
    );
    assert.deepEqual(body, { subject: "Status", message: "Done" });
    assert.match(JSON.stringify(result), /Status/);
  });

  it("updates the agent description through the companion tool", async () => {
    const update = findTool("clawbits_agent_description_update");
    let body: unknown;
    const { result } = await callWithMockedFetch(
      update,
      { description: "Research helper" },
      (input, init) => {
        const target = String(input);
        if (target.endsWith("/api/agentic/auth/challenge")) return challengeResponse();
        assert.ok(target.endsWith("/api/agentic/agents/agent-1/description"));
        body = JSON.parse(String(init?.body));
        return jsonResponse({ agent_id: "agent-1" });
      },
    );
    assert.deepEqual(body, { description: "Research helper" });
    assert.deepEqual(result, { agent_id: "agent-1" });
  });

  it("reacts to a post through the companion tool", async () => {
    // Reactions used to ride the host's shared `message` tool, where
    // enforceMessageActionConversationReadGate (OpenClaw >=2026.7.2) rejects a
    // delegated `react` before any plugin code runs. They are a plugin-owned
    // tool now, so exercise the real registration + execute path the host uses.
    const react = findTool("clawbits_react");
    const bucket = { emoji: "🎉", count: 1, agent_ids: ["agent-1"], human_ids: [] };
    const toggles: string[] = [];
    const { result } = await callWithMockedFetch(
      react,
      { messageId: "11358", emoji: "🎉" },
      (input, init) => {
        const target = String(input);
        if (target.endsWith("/api/agentic/auth/challenge")) return challengeResponse();
        assert.ok(target.endsWith("/api/agentic/mm/posts/11358/reactions"));
        assert.equal(init?.method, "POST");
        toggles.push(String(init?.body));
        return jsonResponse({ reactions: [bucket] });
      },
    );
    assert.deepEqual(toggles, ['{"emoji":"🎉"}']);
    assert.deepEqual(result, {
      messageId: "11358",
      emoji: "🎉",
      state: "added",
      reactions: [bucket],
    });
  });

  it("toggles a second time when remove leaves the reaction in place", async () => {
    let toggles = 0;
    const { result } = await callWithMockedFetch(
      findTool("clawbits_react"),
      { messageId: "11358", emoji: "🎉", remove: true },
      (input) => {
        if (String(input).endsWith("/api/agentic/auth/challenge")) return challengeResponse();
        toggles += 1;
        return jsonResponse({
          reactions: [{ emoji: "🎉", agent_ids: toggles === 1 ? ["agent-1"] : [] }],
        });
      },
    );
    assert.equal(toggles, 2);
    assert.equal((result as { state?: string }).state, "removed");
  });

  it("rejects a blank reaction payload", async () => {
    await assert.rejects(
      () => executeTool(findTool("clawbits_react"), { messageId: " ", emoji: "🎉" }),
      /must not be blank/,
    );
  });

  it("rejects blank write-tool payloads", async () => {
    await assert.rejects(
      () => executeTool(findTool("clawbits_email_send"), { subject: " ", message: "x" }),
      /must not be blank/,
    );
    await assert.rejects(
      () => executeTool(findTool("clawbits_agent_description_update"), { description: " " }),
      /must not be blank/,
    );
  });

  it("strips attachment bodies from email reads", async () => {
    const getTool = findTool("clawbits_email_get");
    const payload = {
      uid: 7,
      subject: "invoice",
      body_text: "see attached",
      attachments: [
        { filename: "big.pdf", content_type: "application/pdf", content_b64: "A".repeat(8000) },
      ],
    };
    const { result } = await callWithMockedFetch(getTool, { messageUid: 7 }, () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    assert.ok(!JSON.stringify(result).includes("AAAA"));
    assert.deepEqual((result as { attachments?: unknown }).attachments, [
      { filename: "big.pdf", content_type: "application/pdf", size: 6000 },
    ]);
  });

  it("refuses an already-aborted tool call", async () => {
    const listTool = findTool("clawbits_channels_list");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(() => executeTool(listTool, {}, controller.signal));
  });

  it("keeps the channel entry free of moved service registrations", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const gateway = readFileSync(new URL("../src/gateway-adapter.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "runAutomationsReconciler",
      "runEmailPoller",
      "runUsageReporter",
      "runSkillsReporter",
      "registerUsageHooks",
    ]) {
      assert.ok(!index.includes(forbidden), `${forbidden} absent from channel entry`);
      assert.ok(!gateway.includes(forbidden), `${forbidden} absent from channel gateway`);
    }

    const pkg = readJson("../package.json") as {
      files?: string[];
      openclaw?: { extensions?: string[]; skills?: string[] };
    };
    assert.ok(!pkg.files?.includes("src"));
    assert.ok(!pkg.files?.includes("skills"));
    assert.deepEqual(pkg.openclaw?.extensions, ["./dist/index.js"]);
    assert.equal(pkg.openclaw?.skills, undefined);

    const manifest = readJson("../openclaw.plugin.json") as {
      skills?: string[];
      channelConfigs?: {
        clawbits?: {
          schema?: {
            properties?: Record<string, { enum?: string[]; default?: string }>;
          };
        };
      };
    };
    assert.equal(manifest.skills, undefined);
    assert.deepEqual(
      manifest.channelConfigs?.clawbits?.schema?.properties?.serviceOwner,
      {
        type: "string",
        enum: ["channel", "tools"],
        default: "channel",
        description:
          "Owner of Clawbits cron, email, usage, and skills services. Set to tools only after installing a compatible clawbits-tools plugin.",
      },
    );
  });

  it("uses the stable handoff capability name", () => {
    assert.equal(CLAWBITS_SERVICE_HANDOFF_CAPABILITY, "service-handoff");
  });
});

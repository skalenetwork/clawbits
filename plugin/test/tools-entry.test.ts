import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type {
  OpenClawPluginApi,
  StubAgentTool,
} from "openclaw/plugin-sdk/plugin-entry";
import toolsEntry, { CLAWBITS_TOOL_NAMES } from "../src/tools-entry.js";
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

interface RegisteredTool {
  tool: StubAgentTool;
  optional: boolean;
}

function runtimeWithHandoff(version?: string): OpenClawPluginApi["runtime"] {
  const contexts = new Map<string, unknown>();
  const runtime: OpenClawPluginApi["runtime"] = {
    version: "2026.6.33",
    channel: {
      runtimeContexts: {
        register({ channelId, capability, context }: {
          channelId: string;
          capability: string;
          context: unknown;
        }) {
          const key = `${channelId}:${capability}`;
          contexts.set(key, context);
          return { dispose: () => contexts.delete(key) };
        },
        get<T>({ channelId, capability }: {
          channelId: string;
          capability: string;
        }): T | undefined {
          return contexts.get(`${channelId}:${capability}`) as T | undefined;
        },
      },
    },
  };
  if (version) registerSlimChannelHandoff(runtime, version);
  return runtime;
}

function pluginApi(
  section: Record<string, unknown>,
  opts: { registrationMode?: string; runtime?: OpenClawPluginApi["runtime"] } = {},
): {
  api: OpenClawPluginApi;
  tools: RegisteredTool[];
  hooks: string[];
  handlers: Map<string, Array<(...args: any[]) => unknown>>;
} {
  const tools: RegisteredTool[] = [];
  const hooks: string[] = [];
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const api: OpenClawPluginApi = {
    registrationMode: opts.registrationMode ?? "tool-discovery",
    config: { channels: { clawbits: section } },
    logger: {},
    runtime: opts.runtime ?? runtimeWithHandoff(),
    registerTool(tool, registration) {
      tools.push({ tool, optional: registration?.optional === true });
    },
    on(hook, handler) {
      hooks.push(hook);
      const existing = handlers.get(hook) ?? [];
      existing.push(handler);
      handlers.set(hook, existing);
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
  api.registerTool = ((tool: StubAgentTool, opts?: { optional?: boolean }) => {
    collected.push({ tool, optional: opts?.optional === true });
    original(tool, opts);
  }) as OpenClawPluginApi["registerTool"];
  toolsEntry.register(api);
  return collected;
}

function findTool(name: (typeof CLAWBITS_TOOL_NAMES)[number]): StubAgentTool {
  const tool = registeredTools().find((candidate) => candidate.tool.name === name)?.tool;
  assert.ok(tool, `tool ${name}`);
  return tool;
}

async function executeTool(
  tool: StubAgentTool,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = (await tool.execute("tool-call-1", params, signal)) as {
    details?: unknown;
  };
  return result.details;
}

async function callWithMockedFetch(
  tool: StubAgentTool,
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

  it("pins tools compatibility to Reef's reviewed OpenClaw floor", () => {
    const expectedFloor = "2026.6.10";
    const dockerfile = readFileSync(
      new URL("../../reef/images/openclaw-runtime/Dockerfile", import.meta.url),
      "utf8",
    );
    assert.equal(
      /^ARG OPENCLAW_VERSION=(\S+)/mu.exec(dockerfile)?.[1],
      expectedFloor,
      "review tools compatibility when Reef changes",
    );
    const pkg = readJson("../package.tools.json") as {
      openclaw?: { compat?: { minGatewayVersion?: string } };
    };
    assert.equal(pkg.openclaw?.compat?.minGatewayVersion, expectedFloor);
  });

  it("registers services only in full runtime mode", () => {
    const discovery = pluginApi({}, { registrationMode: "tool-discovery" });
    toolsEntry.register(discovery.api);
    assert.deepEqual(discovery.hooks, []);

    const full = pluginApi({}, { registrationMode: "full" });
    toolsEntry.register(full.api);
    assert.ok(full.hooks.includes("gateway_start"));
    assert.ok(full.hooks.includes("gateway_stop"));
    assert.ok(full.hooks.includes("cron_changed"));
  });

  it("starts and stops the owner-gated lifecycle idempotently", async () => {
    const setup = pluginApi(
      { serviceOwner: "tools" },
      { registrationMode: "full", runtime: runtimeWithHandoff("0.17.0") },
    );
    toolsEntry.register(setup.api);
    const start = setup.handlers.get("gateway_start")?.[0];
    const stop = setup.handlers.get("gateway_stop")?.[0];
    assert.ok(start);
    assert.ok(stop);
    await start({}, { config: setup.api.config });
    await start({}, { config: setup.api.config });
    await stop();
    await stop();
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
      return new Response(JSON.stringify([{ channel_id: "channel-1" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    assert.deepEqual(result, [{ channel_id: "channel-1" }]);
    assert.equal(authorization, "Bearer secret-key");
    assert.ok(!JSON.stringify(result).includes("secret-key"));
    assert.ok(init?.signal instanceof AbortSignal);
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
        if (target.endsWith("/api/agentic/auth/challenge")) {
          return new Response(
            JSON.stringify({
              session_token: "session-1",
              challenge: "What is the capital of France?",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (target.endsWith("/api/agentic/agents/agent-1/email/send")) {
          body = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ status: "sent", subject: "Status" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (target.endsWith("/api/agentic/mm/channels/channel-1/posts")) {
          return new Response(JSON.stringify({ post_id: "mirror-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
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
        if (target.endsWith("/api/agentic/auth/challenge")) {
          return new Response(
            JSON.stringify({
              session_token: "session-1",
              challenge: "What is the capital of France?",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        assert.ok(target.endsWith("/api/agentic/agents/agent-1/description"));
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ agent_id: "agent-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    assert.deepEqual(body, { description: "Research helper" });
    assert.deepEqual(result, { agent_id: "agent-1" });
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
    const actions = readFileSync(new URL("../src/channel-actions.ts", import.meta.url), "utf8");
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
    assert.ok(!actions.includes("send_email"));
    assert.ok(!actions.includes("update_description"));

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

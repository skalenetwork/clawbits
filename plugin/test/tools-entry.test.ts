import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getToolPluginMetadata,
  type DefinedToolPluginTool,
  type ToolPluginApi,
} from "openclaw/plugin-sdk/tool-plugin";
import toolsEntry, { CLAWBITS_TOOL_NAMES } from "../src/tools-entry.js";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, unknown>;
}

/** Numeric dotted-version compare (OpenClaw uses YYYY.M.PATCH). */
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
};

function apiWithClawBitsSection(
  section: Record<string, unknown>,
  registerTool: (tool: DefinedToolPluginTool) => void = () => {},
): ToolPluginApi {
  return {
    config: { channels: { clawbits: section } },
    registerTool,
  };
}

function configuredApi(registerTool: (tool: DefinedToolPluginTool) => void): ToolPluginApi {
  return apiWithClawBitsSection({ accounts: { default: { ...DEFAULT_ACCOUNT } } }, registerTool);
}

function registeredTools(api?: ToolPluginApi): DefinedToolPluginTool[] {
  const tools: DefinedToolPluginTool[] = [];
  toolsEntry.register(api ?? configuredApi((tool) => tools.push(tool)));
  return tools;
}

function findTool(name: (typeof CLAWBITS_TOOL_NAMES)[number]): DefinedToolPluginTool {
  const tool = registeredTools().find((candidate) => candidate.name === name);
  assert.ok(tool?.execute, `tool ${name} with execute`);
  return tool;
}

function executionContext(api: ToolPluginApi, signal?: AbortSignal) {
  return {
    api,
    toolCallId: "tool-call-1",
    ...(signal ? { signal } : {}),
  };
}

/** Run one tool against a mocked global fetch; returns the result and the fetch call's init. */
async function callWithMockedFetch(
  tool: DefinedToolPluginTool,
  params: Record<string, unknown>,
  api: ToolPluginApi,
  respond: (input: unknown, init?: RequestInit) => Response,
): Promise<{ result: unknown; init: RequestInit | undefined }> {
  const originalFetch = globalThis.fetch;
  let seenInit: RequestInit | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      seenInit = init;
      return respond(input, init);
    };
    const result = await tool.execute!(params, {}, executionContext(api));
    return { result, init: seenInit };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("clawbits tools plugin", () => {
  it("declares stable optional tools matching the publish manifest", () => {
    const metadata = getToolPluginMetadata(toolsEntry);
    assert.ok(metadata);
    assert.equal(metadata.id, "clawbits-tools");
    assert.deepEqual(metadata.tools.map((tool) => tool.name), [...CLAWBITS_TOOL_NAMES]);
    assert.ok(metadata.tools.every((tool) => tool.optional));

    const manifest = readJson("../openclaw.tools.plugin.json") as {
      contracts?: { tools?: string[] };
      toolMetadata?: Record<string, { optional?: boolean }>;
    };
    assert.deepEqual(manifest.contracts?.tools, [...CLAWBITS_TOOL_NAMES]);
    assert.deepEqual(Object.keys(manifest.toolMetadata ?? {}), [...CLAWBITS_TOOL_NAMES]);
    assert.ok(Object.values(manifest.toolMetadata ?? {}).every((tool) => tool.optional === true));
  });

  it("publishes a separate built entry", () => {
    const pkg = readJson("../package.tools.json") as {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
      openclaw?: { id?: string; extensions?: string[]; runtimeExtensions?: string[] };
    };
    const channelPkg = readJson("../package.json") as { version?: string };
    assert.equal(pkg.name, "clawbits-openclaw-tools");
    assert.equal(
      pkg.version?.split(".").slice(0, 2).join("."),
      channelPkg.version?.split(".").slice(0, 2).join("."),
      "both clients send X-Clawbits-Plugin-Version and must share a release line",
    );
    assert.equal(pkg.openclaw?.id, "clawbits-tools");
    assert.deepEqual(pkg.openclaw?.extensions, ["./dist/tools-entry.js"]);
    assert.deepEqual(pkg.openclaw?.runtimeExtensions, ["./dist/tools-entry.js"]);
    assert.ok(pkg.dependencies?.["typebox"], "staged artifact must declare its runtime import");
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
    // Three copies of one number. The publish workflow validates the floor and
    // the build SDK, so a drifted copy would advertise support the pipeline
    // never exercises — how this package ended up inheriting the channel's
    // 2026.6.10 for an SDK surface the channel never imports.
    assert.equal(pkg.openclaw?.compat?.pluginApi, `>=${floor}`);
    assert.equal(pkg.peerDependencies?.["openclaw"], `>=${floor}`);
    assert.ok(
      compareVersions(floor, build) <= 0,
      "compat floor cannot exceed the SDK the artifact is built against",
    );
  });

  it("pins tools compatibility to Reef's reviewed OpenClaw floor", () => {
    // Changing either side requires an explicit compatibility review. This
    // prevents a package-only floor bump from silently breaking Reef and a
    // Reef-only runtime bump from silently dropping older supported installs.
    const expectedFloor = "2026.6.10";
    const dockerfile = readFileSync(
      new URL("../../reef/images/openclaw-runtime/Dockerfile", import.meta.url),
      "utf8",
    );
    const reefVersion = /^ARG OPENCLAW_VERSION=(\S+)/mu.exec(dockerfile)?.[1];
    assert.equal(reefVersion, expectedFloor, "review tools compatibility when Reef changes");

    const pkg = readJson("../package.tools.json") as {
      openclaw?: { compat?: { minGatewayVersion?: string } };
    };
    assert.equal(
      pkg.openclaw?.compat?.minGatewayVersion,
      expectedFloor,
      "review Reef compatibility before changing the tools floor",
    );
  });

  it("ships no channel surface in the entry or either manifest", () => {
    // Assert on the shipped artifacts, not on stub behavior: the entry object
    // carries no channel plugin, and neither manifest declares channels or
    // skills — the channel package is the only one allowed to.
    assert.ok(!("channelPlugin" in toolsEntry));
    const pkg = readJson("../package.tools.json") as {
      openclaw?: Record<string, unknown>;
    };
    assert.equal(pkg.openclaw?.["channels"], undefined);
    assert.equal(pkg.openclaw?.["skills"], undefined);
    const manifest = readJson("../openclaw.tools.plugin.json");
    assert.equal(manifest["channels"], undefined);
    assert.equal(manifest["skills"], undefined);

    const tools: DefinedToolPluginTool[] = [];
    let channelRegistrations = 0;
    toolsEntry.register({
      ...configuredApi((tool) => tools.push(tool)),
      registerChannel: () => {
        channelRegistrations += 1;
      },
    });
    assert.deepEqual(tools.map((tool) => tool.name), [...CLAWBITS_TOOL_NAMES]);
    assert.equal(channelRegistrations, 0);
  });

  it("uses the channel account config without exposing its API key", async () => {
    const listTool = findTool("clawbits_channels_list");
    let authorization = "";
    const { result, init } = await callWithMockedFetch(
      listTool,
      {},
      configuredApi(() => {}),
      (input, requestInit) => {
        authorization = new Headers(requestInit?.headers).get("Authorization") ?? "";
        assert.equal(String(input), "https://app.clawbits.test/api/agentic/mm/channels");
        return new Response(JSON.stringify([{ channel_id: "channel-1" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    assert.deepEqual(result, [{ channel_id: "channel-1" }]);
    assert.equal(authorization, "Bearer secret-key");
    assert.ok(!JSON.stringify(result).includes("secret-key"));
    assert.ok(init?.signal instanceof AbortSignal, "every tool request is abortable/bounded");
  });

  it("fails clearly when the channel account is missing", async () => {
    const infoTool = findTool("clawbits_agent_info");
    await assert.rejects(
      async () =>
        infoTool.execute!({}, {}, executionContext({ config: {} })),
      /channel plugin first/,
    );
  });

  it("rejects an accountId that names no configured account instead of falling back", async () => {
    const infoTool = findTool("clawbits_agent_info");
    // Inline creds plus named accounts: a typo'd id must not silently resolve
    // to the inline account's mailbox.
    const api = apiWithClawBitsSection({
      ...DEFAULT_ACCOUNT,
      accounts: { work: { ...DEFAULT_ACCOUNT, agentId: "agent-work" } },
    });
    await assert.rejects(
      async () => infoTool.execute!({ accountId: "wrok" }, {}, executionContext(api)),
      /Unknown Clawbits account 'wrok'/,
    );
  });

  it("honors the account enabled kill switch", async () => {
    const listTool = findTool("clawbits_channels_list");
    const api = apiWithClawBitsSection({
      accounts: { default: { ...DEFAULT_ACCOUNT, enabled: false } },
    });
    await assert.rejects(
      async () => listTool.execute!({}, {}, executionContext(api)),
      /disabled/,
    );
  });

  it("honors emailEnabled for email tools while non-email tools keep working", async () => {
    const api = () =>
      apiWithClawBitsSection({
        accounts: { default: { ...DEFAULT_ACCOUNT, emailEnabled: false } },
      });
    for (const name of ["clawbits_email_inbox", "clawbits_email_get"] as const) {
      const tool = findTool(name);
      await assert.rejects(
        async () =>
          tool.execute!(
            name === "clawbits_email_get" ? { messageUid: 1 } : {},
            {},
            executionContext(api()),
          ),
        /email integration is disabled/,
      );
    }
    const listTool = findTool("clawbits_channels_list");
    const { result } = await callWithMockedFetch(
      listTool,
      {},
      api(),
      () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    assert.deepEqual(result, []);
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
    const { result } = await callWithMockedFetch(
      getTool,
      { messageUid: 7 },
      configuredApi(() => {}),
      (input) => {
        assert.equal(
          String(input),
          "https://app.clawbits.test/api/agentic/agents/agent-1/email/7",
        );
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    const detail = result as {
      attachments?: Array<Record<string, unknown>>;
      attachments_note?: string;
      body_text?: string;
    };
    assert.equal(detail.body_text, "see attached");
    assert.ok(!JSON.stringify(result).includes("AAAA"), "no base64 body in tool output");
    assert.deepEqual(detail.attachments, [
      { filename: "big.pdf", content_type: "application/pdf", size: 6000 },
    ]);
    assert.ok(detail.attachments_note);
  });

  it("refuses to run when the runtime signal is already aborted", async () => {
    const listTool = findTool("clawbits_channels_list");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(async () =>
      listTool.execute!(
        {},
        {},
        executionContext(configuredApi(() => {}), controller.signal),
      ),
    );
  });
});

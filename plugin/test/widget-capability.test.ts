// The `widgets` capability (WIDGETS_AGENTS_PLAN §4 P2/P3): claimed on the alive ping only when a
// game could be played here, and the ping otherwise unchanged.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveClawBitsAccount } from "../src/accounts.js";
import type { ClawBitsClient } from "../src/client.js";
import { runLivenessPinger } from "../src/liveness.js";
import {
  type ClawBitsServiceHandoff,
  companionToolRegistered,
  onCompanionToolsChanged,
  registerSlimChannelHandoff,
} from "../src/service-handoff.js";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { gameRoute } from "../src/gateway-adapter.js";
import type { ResolvedClawBitsAccount } from "../src/types.js";
import { agentCapabilities, optionalToolAllowed } from "../src/widgets/capability.js";

const registered = (name: string): boolean => name === "clawbits_widget_act";
const nothingRegistered = (): boolean => false;
const on = { widgets: true };

function cfg(value: Record<string, unknown>): OpenClawConfig {
  return value as OpenClawConfig;
}

const IMAGE = cfg({ tools: { alsoAllow: ["browser", "clawbits_react", "clawbits_widget_act"] } });
/** Where OpenClaw routes a game peer by default: a session of its own. */
const ROUTE = { agentId: "main", sessionKey: "agent:main:clawbits:channel:widget-probe" };

describe("widgets capability", () => {
  it("is claimed when the act tool is registered and allowed", () => {
    assert.deepEqual(agentCapabilities(IMAGE, on, ROUTE, registered), ["widgets"]);
  });

  it("is not claimed when the account turned games off", () => {
    assert.deepEqual(agentCapabilities(IMAGE, { widgets: false }, ROUTE, registered), []);
  });

  it("is not claimed until the tools plugin registered the act tool", () => {
    assert.deepEqual(agentCapabilities(IMAGE, on, ROUTE, nothingRegistered), []);
  });

  it("is not claimed when tool policy hides the optional act tool", () => {
    assert.deepEqual(agentCapabilities(cfg({}), on, ROUTE, registered), [], "optional tools need an allow");
    assert.deepEqual(
      agentCapabilities(cfg({ tools: { alsoAllow: ["clawbits_react"] } }), on, ROUTE, registered),
      [],
    );
    assert.deepEqual(
      agentCapabilities(
        cfg({ tools: { alsoAllow: ["clawbits_widget_act"], deny: ["clawbits_widget_*"] } }),
        on,
        ROUTE,
        registered,
      ),
      [],
    );
  });

  it("reads the tool policy of the agent a game routes to", () => {
    const agents = { list: [{ id: "games", tools: { alsoAllow: ["clawbits_widget_act"] } }, { id: "main" }] };
    const routedTo = (agentId: string) => ({
      agentId,
      sessionKey: `agent:${agentId}:clawbits:channel:widget-probe`,
    });
    assert.deepEqual(agentCapabilities(cfg({ agents }), on, routedTo("games"), registered), ["widgets"]);
    assert.deepEqual(agentCapabilities(cfg({ agents }), on, routedTo("main"), registered), []);
  });

  it("is not claimed when games can't have a session of their own", () => {
    // `session.groupScope: "main"`, global or a binding's, routes a game peer to the main session.
    assert.deepEqual(agentCapabilities(IMAGE, on, { agentId: "main", sessionKey: "agent:main:main" }, registered), []);
    assert.deepEqual(agentCapabilities(IMAGE, on, undefined, registered), [], "no route, no move");
  });

  it("probes the route a move's dispatch takes, bindings included", () => {
    const peers: unknown[] = [];
    const ctx = (bindingFoldsPeers: boolean) =>
      ({
        cfg: IMAGE,
        accountId: "default",
        channelRuntime: {
          routing: {
            // OpenClaw applies a matched binding's `session.groupScope` (src/routing/resolve-route.ts).
            resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => {
              peers.push(peer);
              return {
                agentId: "main",
                sessionKey: bindingFoldsPeers ? "agent:main:main" : `agent:main:clawbits:channel:${peer.id}`,
              };
            },
          },
        },
      }) as unknown as ChannelGatewayContext<ResolvedClawBitsAccount>;
    assert.deepEqual(gameRoute(ctx(false)), ROUTE);
    assert.deepEqual(agentCapabilities(IMAGE, on, gameRoute(ctx(false)), registered), ["widgets"]);
    assert.deepEqual(agentCapabilities(IMAGE, on, gameRoute(ctx(true)), registered), []);
    assert.deepEqual(peers[0], { kind: "channel", id: "widget-probe" });
    assert.equal(
      gameRoute({ cfg: IMAGE, accountId: "default", channelRuntime: undefined } as unknown as ChannelGatewayContext<ResolvedClawBitsAccount>),
      undefined,
    );
  });

  it("reads OpenClaw's optional-tool allow forms", () => {
    const allowed = (tools: Record<string, unknown>, agentId?: string, agents?: unknown) =>
      optionalToolAllowed(cfg({ tools, ...(agents ? { agents } : {}) }), "clawbits_widget_act", "clawbits-tools", agentId);
    assert.equal(allowed({ alsoAllow: ["clawbits_widget_act"] }), true);
    assert.equal(allowed({ allow: ["CLAWBITS_WIDGET_ACT"] }), true, "names compare case-insensitively");
    // OpenClaw honours an allow glob for optional tools only from 2026.9.1, past the floor.
    assert.equal(allowed({ alsoAllow: ["clawbits_*"] }), false, "an allow glob doesn't claim");
    assert.equal(allowed({ alsoAllow: ["clawbits-tools"] }), true, "the plugin id");
    assert.equal(allowed({ alsoAllow: ["group:plugins"] }), true);
    assert.equal(allowed({ allow: ["*"] }), true);
    assert.equal(allowed({ alsoAllow: ["clawbits_widget_get"] }), false);
    assert.equal(allowed({ alsoAllow: ["*"], deny: ["clawbits-tools"] }), false);
    assert.equal(
      allowed({}, "main", { list: [{ id: "main", tools: { alsoAllow: ["clawbits_widget_act"] } }] }),
      true,
      "the routed agent's own allowlist",
    );
    assert.equal(
      allowed({}, "other", { list: [{ id: "main", tools: { alsoAllow: ["clawbits_widget_act"] } }] }),
      false,
      "another agent's allowlist doesn't count",
    );
    assert.equal(
      allowed({ alsoAllow: ["clawbits_widget_act"] }, "main", { entries: { main: { tools: { deny: ["clawbits_widget_act"] } } } }),
      false,
    );
  });

  it("follows the account's widgets flag, on by default", () => {
    const section = { endpoint: "http://h", orgId: "o", agentId: "a", apiKey: "k", channelId: "c" };
    assert.equal(resolveClawBitsAccount({ cfg: cfg({ channels: { clawbits: section } }) }).widgets, true);
    assert.equal(
      resolveClawBitsAccount({ cfg: cfg({ channels: { clawbits: { ...section, widgets: false } } }) }).widgets,
      false,
    );
    assert.equal(
      resolveClawBitsAccount({
        cfg: cfg({ channels: { clawbits: { ...section, accounts: { bot: { widgets: false } } } } }),
        accountId: "bot",
      }).widgets,
      false,
    );
  });
});

describe("companion tool report", () => {
  afterEach(() => {
    let context: ClawBitsServiceHandoff | undefined;
    registerSlimChannelHandoff(
      { channel: { runtimeContexts: { register: ({ context: c }) => ((context = c), { dispose() {} }), get: () => undefined } } },
      "0.23.0",
    );
    context?.reportCompanionTools?.([]);
  });

  it("tells the channel which tools the companion registered, and when that changes", () => {
    let context: ClawBitsServiceHandoff | undefined;
    registerSlimChannelHandoff(
      { channel: { runtimeContexts: { register: ({ context: c }) => ((context = c), { dispose() {} }), get: () => undefined } } },
      "0.23.0",
    );
    let changes = 0;
    const unsubscribe = onCompanionToolsChanged(() => {
      changes += 1;
    });
    try {
      assert.equal(companionToolRegistered("clawbits_widget_act"), false);
      context?.reportCompanionTools?.(["clawbits_widget_get", "clawbits_widget_act"]);
      assert.equal(companionToolRegistered("clawbits_widget_act"), true);
      context?.reportCompanionTools?.(["clawbits_widget_act", "clawbits_widget_get"]);
      assert.equal(changes, 1, "the same set again is no change");
    } finally {
      unsubscribe();
    }
  });
});

describe("alive ping capabilities", () => {
  function pinger(capabilities: () => string[], gate?: () => Promise<void>) {
    const bodies: unknown[] = [];
    let listener: (() => void) | undefined;
    const ac = new AbortController();
    let pinged: () => void = () => {};
    const client = {
      hasApiKey: () => true,
      request: async (_method: string, _path: string, opts?: { json?: unknown }) => {
        bodies.push(opts?.json);
        pinged();
        await gate?.();
      },
    } as unknown as ClawBitsClient;
    const nextPing = () => new Promise<void>((resolve) => (pinged = resolve));
    const first = nextPing();
    const done = runLivenessPinger({
      client,
      intervalMs: 60_000,
      abortSignal: ac.signal,
      accountId: "default",
      capabilities,
      onCapabilitiesChanged: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
    });
    return { bodies, first, nextPing, changed: () => listener?.(), stop: () => ac.abort(), done, hasListener: () => listener !== undefined };
  }

  /** Let the pinger finish its request and fall asleep until the interval. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("sends the body as before when there is nothing to claim, and restates a change at once", async () => {
    let caps: string[] = [];
    const p = pinger(() => caps);
    await p.first;
    assert.deepEqual(p.bodies, [{ agent_type: "openclaw" }]);

    await settle();
    const second = p.nextPing();
    caps = ["widgets"];
    p.changed();
    await second;
    assert.deepEqual(p.bodies[1], { agent_type: "openclaw", capabilities: ["widgets"] });

    await settle();
    p.changed();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(p.bodies.length, 2, "an unchanged set waits for the interval");
    p.stop();
    await p.done;
    assert.equal(p.hasListener(), false, "unsubscribed on stop");
  });

  it("restates a change that landed while a ping was in flight", async () => {
    let caps: string[] = [];
    let release: () => void = () => {};
    let held = true;
    const p = pinger(
      () => caps,
      () => (held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()),
    );
    await p.first;
    // Mid-request: nothing to wake yet, so only the recheck after it can send the change.
    caps = ["widgets"];
    p.changed();
    held = false;
    const second = p.nextPing();
    release();
    await second;
    assert.deepEqual(p.bodies, [{ agent_type: "openclaw" }, { agent_type: "openclaw", capabilities: ["widgets"] }]);
    p.stop();
    await p.done;
  });
});

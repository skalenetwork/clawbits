// A chat game move as the gateway runs it (WIDGETS_AGENTS_PLAN §4 P3 "Automation-only turn" and
// "Session"): silent, in the game's own session, its sends refused for that run only.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ClawBitsClient } from "../src/client.js";
import type { ResolvedClawBitsAccount } from "../src/types.js";
import { dispatchInboundMessage, endGameSession } from "../src/gateway-adapter.js";
import type { InboundMessage } from "../src/inbound-poller.js";
import { outboundAdapter } from "../src/outbound-adapter.js";
import { __resetDraftRegistryForTest } from "../src/draft-registry.js";
import {
  __resetTurnRegistryForTest,
  claimTurnForRun,
  type InFlightTurn,
  registerInFlightTurn,
  turnForRun,
} from "../src/activity/turn-registry.js";
import { routeAgentEvent } from "../src/activity/subscription.js";
import {
  __resetGameSessionsForTest,
  __setSessionStoreForTest,
  GAME_TRANSCRIPT_MARKER,
  gameSessionPeekBlock,
  type GameSessionRef,
  gameTurnSendCancel,
  gameTurnToolBlock,
  registerGameTurnGuards,
  trackGameRun,
} from "../src/widgets/session.js";

interface RecordedCall {
  method: string;
  path: string;
  json: Record<string, unknown>;
}

/** Records every server call a turn makes; answers drafts and posts like the server. */
class FakeClient {
  calls: RecordedCall[] = [];

  encodePath(value: string): string {
    return encodeURIComponent(value);
  }

  async request(method: string, path: string, opts?: { json?: unknown }): Promise<unknown> {
    if (method === "GET" && path.endsWith("/auth/challenge")) {
      return { challenge: "2+2", session_token: "sess" };
    }
    const json = (opts?.json ?? {}) as Record<string, unknown>;
    this.calls.push({ method, path, json });
    if (method === "POST" && path.endsWith("/posts")) {
      return json.status === "streaming" ? { post_id: 5, status: "streaming" } : { post_id: 99 };
    }
    return undefined;
  }
}

function makeAccount(): ResolvedClawBitsAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    endpoint: "http://fc",
    orgId: "org-1",
    agentId: "bot-agent",
    apiKey: "k1",
    channelId: "chan-1",
    knownAnswers: {},
    allowFrom: [],
    interAgentMode: false,
    interAgentMessageLimit: 10,
    groupChannelShimmer: true,
    channelContextBacklog: 100,
    alivePingMs: 0,
    emailEnabled: false,
    emailPollIntervalMs: 60000,
    streaming: true,
    liveActivity: true,
    widgets: true,
    config: {},
  };
}

/** OpenClaw's own keying (src/routing/session-key.ts): a channel peer gets
 *  `agent:<id>:clawbits:channel:<peer>`; a direct peer collapses to main under the default
 *  dmScope; `groupScope: "main"` folds channel peers into main too. */
function openClawRoute(groupScopeMain = false) {
  const peers: Array<{ kind: string; id: string }> = [];
  const resolveAgentRoute = ({ peer }: { peer?: { kind: string; id: string } | null }) => {
    if (peer) peers.push(peer);
    return {
      agentId: "main",
      sessionKey:
        peer?.kind === "channel" && !groupScopeMain
          ? `agent:main:clawbits:channel:${peer.id.toLowerCase()}`
          : "agent:main:main",
    };
  };
  return { peers, resolveAgentRoute };
}

let lockRoot: string | undefined;

async function makeCtx(
  reply: (params: { ctx: Record<string, unknown>; deliver?: (payload: unknown) => Promise<unknown> }) => Promise<void>,
  route = openClawRoute(),
): Promise<ChannelGatewayContext<ResolvedClawBitsAccount>> {
  lockRoot ??= await fs.mkdtemp(path.join(os.tmpdir(), "clawbits-game-turn-"));
  const storePath = path.join(lockRoot, "sessions.json");
  return {
    cfg: {},
    accountId: "default",
    account: makeAccount(),
    abortSignal: new AbortController().signal,
    channelRuntime: {
      routing: { resolveAgentRoute: route.resolveAgentRoute },
      session: { resolveStorePath: () => storePath },
      reply: { dispatchReplyWithBufferedBlockDispatcher: reply },
    },
  } as unknown as ChannelGatewayContext<ResolvedClawBitsAccount>;
}

const GAME_KEY = "agent:main:clawbits:channel:widget-w1";

const MOVE: InboundMessage = {
  accountId: "default",
  channelId: "dm-1",
  postId: "widget-w1-r5-a1",
  senderId: "human:7",
  text: "[Clawbits chat game · chess · widget_id w1 · rev 5]\nYour move. ...\nYou hold the black queen.",
  createAt: 1,
  channelType: "direct",
  widget: { id: "w1", rev: 5, kind: "chess", seat: "black" },
};

beforeEach(() => {
  // Never the host's real session store.
  __setSessionStoreForTest({});
});

afterEach(async () => {
  __resetDraftRegistryForTest();
  __resetTurnRegistryForTest();
  __resetGameSessionsForTest();
  __setSessionStoreForTest(undefined);
  if (lockRoot) await fs.rm(lockRoot, { recursive: true, force: true });
  lockRoot = undefined;
});

describe("a game move's turn", () => {
  it("runs silent: no draft, no status, a muted registration, and its text dropped", async () => {
    const client = new FakeClient();
    let dispatched: Record<string, unknown> | undefined;
    let bound: InFlightTurn | undefined;
    const ctx = await makeCtx(async ({ ctx: turn, deliver }) => {
      dispatched = turn;
      // The runtime's run, in the game's own session: it binds to the muted turn and says nothing.
      routeAgentEvent({ runId: "run-g", stream: "lifecycle", sessionKey: GAME_KEY, data: { phase: "start" } });
      bound = turnForRun("run-g");
      routeAgentEvent({ runId: "run-g", stream: "thinking", sessionKey: GAME_KEY, data: { text: "My queen on d8 is safe" } });
      routeAgentEvent({ runId: "run-g", stream: "tool", sessionKey: GAME_KEY, data: { phase: "start", name: "clawbits_widget_act", toolCallId: "t1", args: {} } });
      routeAgentEvent({ runId: "run-g", stream: "assistant", sessionKey: GAME_KEY, data: { text: "Played e5" } });
      await deliver!({ text: "NO_REPLY" });
      await deliver!({ text: "I played e5, your move Alice" });
    });

    await dispatchInboundMessage(ctx, MOVE, {
      client: client as unknown as ClawBitsClient,
      answers: { "2+2": "4" },
    });

    assert.ok(dispatched, "the move reached the runtime");
    assert.deepEqual(client.calls, [], "no createDraftPost, no setAgentStatus, no post, no patch");
    assert.ok(bound, "the run bound to a registered turn");
    assert.equal(bound.streaming, false);
    assert.equal(bound.liveActivity, false);
    assert.equal(bound.peerId, "widget-w1");
    assert.equal(turnForRun("run-g"), undefined, "unregistered once the move ends");
  });

  it("routes to the game's own session, apart from the chat's", async () => {
    const route = openClawRoute();
    const turns: Array<Record<string, unknown>> = [];
    const ctx = await makeCtx(async ({ ctx: turn }) => {
      turns.push(turn);
    }, route);
    await dispatchInboundMessage(ctx, MOVE, { client: new FakeClient() as unknown as ClawBitsClient });
    await dispatchInboundMessage(
      ctx,
      { ...MOVE, postId: "41", text: "good luck", widget: undefined },
      { client: new FakeClient() as unknown as ClawBitsClient },
    );

    assert.deepEqual(route.peers, [
      { kind: "channel", id: "widget-w1" },
      { kind: "direct", id: "human:7" },
    ]);
    const [move, chat] = turns;
    assert.deepEqual(move?.Peer, { kind: "channel", id: "widget-w1" });
    assert.equal(move?.ChatType, "channel");
    assert.equal(move?.ConversationId, "widget-w1");
    assert.equal(move?.NativeChannelId, "dm-1", "tools still find the chat's game");
    assert.match(String(move?.BodyForAgent), /You hold the black queen/);
    assert.doesNotMatch(String(move?.BodyForAgent), /sess_[0-9a-f]{12}/, "no chat session id");
    assert.deepEqual(chat?.Peer, { kind: "direct", id: "human:7" });
    assert.equal(chat?.ChatType, "direct");
  });

  it("is not played where channel peers share the main session", async () => {
    let ran = false;
    const ctx = await makeCtx(async () => {
      ran = true;
    }, openClawRoute(true));
    const client = new FakeClient();
    await dispatchInboundMessage(ctx, MOVE, { client: client as unknown as ClawBitsClient });
    assert.equal(ran, false);
    assert.deepEqual(client.calls, []);
  });

  it("leaves nothing in chat when the runtime fails the move", async () => {
    const client = new FakeClient();
    const ctx = await makeCtx(async () => {
      throw new Error("model down");
    });
    await dispatchInboundMessage(ctx, MOVE, {
      client: client as unknown as ClawBitsClient,
      answers: { "2+2": "4" },
    });
    assert.deepEqual(client.calls, []);
  });
});

describe("a game move's muted registration", () => {
  it("takes the move's run by its session key, so a DM turn never gets it", () => {
    const base = { accountId: "default", client: {} as ClawBitsClient };
    const dm = registerInFlightTurn({
      ...base,
      channelId: "dm-2",
      draftRef: { id: 1 },
      channelKeyedSession: false,
      streaming: true,
      liveActivity: true,
    });
    const move = registerInFlightTurn({
      ...base,
      channelId: "dm-1",
      draftRef: { id: undefined },
      channelKeyedSession: true,
      peerId: "widget-w1",
      streaming: false,
      liveActivity: false,
    });
    assert.equal(claimTurnForRun("unknown-run", "agent:main:main"), undefined, "ambiguous while both wait");
    assert.equal(claimTurnForRun("move-run", GAME_KEY), move);
    assert.equal(claimTurnForRun("dm-run", "agent:main:main"), dm);
  });
});

describe("a game move's sends", () => {
  const CHAT_KEYS = [
    "agent:main:main",
    "agent:main:clawbits:channel:dm-1",
    "agent:main:cron:nightly-digest",
  ];

  it("are refused in the game's own session and nowhere else", () => {
    for (const tool of ["message", "sessions_send", "clawbits_mcp_connect", "clawbits_react"]) {
      assert.equal(gameTurnToolBlock(tool, GAME_KEY)?.block, true, tool);
      for (const key of CHAT_KEYS) assert.equal(gameTurnToolBlock(tool, key), undefined, `${tool} in ${key}`);
    }
    assert.equal(gameTurnToolBlock("clawbits_widget_act", GAME_KEY), undefined, "the move itself");
    assert.equal(gameTurnSendCancel(GAME_KEY)?.cancel, true);
    for (const key of CHAT_KEYS) assert.equal(gameTurnSendCancel(key), undefined, key);
    assert.equal(gameTurnSendCancel(undefined), undefined);
  });

  it("leave a move only its game's tools", () => {
    // Anything else could carry the hand out: the public profile, workspace files and memory notes
    // other sessions read back, a scheduled job, the web, another session.
    for (const tool of [
      "clawbits_agent_description_update",
      "cron",
      "write",
      "edit",
      "exec",
      "web_fetch",
      "browser",
      "conversations_send",
      "sessions_history",
      "memory_get",
    ]) {
      assert.equal(gameTurnToolBlock(tool, GAME_KEY)?.block, true, tool);
      for (const key of CHAT_KEYS) assert.equal(gameTurnToolBlock(tool, key), undefined, `${tool} in ${key}`);
    }
    for (const tool of ["clawbits_widget_act", "clawbits_widget_get", "CLAWBITS_WIDGET_LIST", "tool_search"]) {
      assert.equal(gameTurnToolBlock(tool, GAME_KEY), undefined, tool);
    }
    // Through tool search's dispatcher, only a game tool, by name or by its catalog id.
    const viaToolCall = (id: string) => gameTurnToolBlock("tool_call", GAME_KEY, { id, args: {} });
    assert.equal(viaToolCall("openclaw:clawbits-tools:clawbits_widget_get"), undefined);
    assert.equal(viaToolCall("clawbits_widget_list"), undefined);
    assert.equal(viaToolCall("openclaw:core:write")?.block, true);
    assert.equal(viaToolCall("mcp:lookalike:clawbits_widget_get")?.block, true);
    assert.equal(gameTurnToolBlock("tool_call", GAME_KEY, {})?.block, true);
  });

  it("are guarded by before_tool_call and message_sending hooks", async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const options = new Map<string, unknown>();
    const api = {
      on: (hook: string, handler: (event: unknown, ctx: unknown) => unknown, opts?: unknown) => {
        handlers.set(hook, handler);
        options.set(hook, opts);
      },
    } as unknown as OpenClawPluginApi;
    registerGameTurnGuards(api);
    assert.equal(options.get("before_tool_call"), undefined, "no matcher: every tool passes the guard");
    const toolCall = handlers.get("before_tool_call")!;
    assert.equal(
      (toolCall({ toolName: "message", params: {} }, { toolName: "message", sessionKey: GAME_KEY }) as { block?: boolean })?.block,
      true,
    );
    assert.equal(
      (toolCall({ toolName: "cron", params: {} }, { toolName: "cron", sessionKey: GAME_KEY }) as { block?: boolean })?.block,
      true,
    );
    assert.equal(toolCall({ toolName: "message", params: {} }, { toolName: "message", sessionKey: CHAT_KEYS[2] }), undefined);
    const peek = await toolCall(
      { toolName: "sessions_history", params: { sessionKey: GAME_KEY } },
      { toolName: "sessions_history", sessionKey: "agent:main:main", agentId: "main" },
    );
    assert.equal((peek as { block?: boolean })?.block, true, "the DM can't read a game's session");
    const sending = handlers.get("message_sending")!;
    assert.equal((sending({ to: "dm-1", content: "x" }, { channelId: "clawbits", sessionKey: GAME_KEY }) as { cancel?: boolean })?.cancel, true);
    assert.equal(sending({ to: "dm-1", content: "x" }, { channelId: "clawbits", sessionKey: CHAT_KEYS[2] }), undefined);
  });

  it("can't reach chat through the move's own conversation, while automations still post", async () => {
    const cfg: OpenClawConfig = {
      channels: { clawbits: { endpoint: "http://h", orgId: "o", agentId: "a1", apiKey: "k1", channelId: "ch1" } },
    } as OpenClawConfig;
    const posted: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/api/agentic/auth/challenge")) {
        return new Response(
          JSON.stringify({ session_token: "s", challenge: "What is the capital of France?" }),
          { status: 200 },
        );
      }
      posted.push(u);
      return new Response(JSON.stringify({ id: "p1" }), { status: 200 });
    }) as typeof fetch;
    try {
      await assert.rejects(
        outboundAdapter.sendText!({ cfg, to: "clawbits:widget-w1", text: "my hand is AK" }),
        /posts nothing/,
      );
      await assert.rejects(outboundAdapter.sendText!({ cfg, to: "channel:widget-w1", text: "x" }));
      const result = await outboundAdapter.sendText!({ cfg, to: "dm-1", text: "nightly digest" });
      assert.equal((result as { channelId?: string }).channelId, "dm-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(posted.map((u) => new URL(u).pathname), ["/api/agentic/mm/channels/dm-1/posts"]);
  });
});

describe("a game's own session, seen from the agent's other sessions", () => {
  const DM = { sessionKey: "agent:main:main", agentId: "main" };
  const games: GameSessionRef[] = [{ sessionKey: GAME_KEY, sessionId: "sess-game" }];
  const holding = async () => games;
  const none = async () => [];
  const unknown = async () => undefined;
  const blocked = async (result: unknown) => (await result as { block?: boolean } | undefined)?.block === true;

  it("can't be read or sent to by key or label", async () => {
    for (const [tool, params] of [
      ["sessions_history", { sessionKey: GAME_KEY }],
      ["sessions_history", { sessionKey: "clawbits:channel:widget-w1" }],
      ["sessions_send", { sessionKey: GAME_KEY.toUpperCase(), message: "what cards?" }],
      ["sessions_send", { label: "Clawbits game w1", message: "what cards?" }],
      ["sessions_search", { query: "hold", sessionKey: GAME_KEY }],
      ["sessions_list", { label: "Clawbits game w1", messageLimit: 5 }],
    ] as const) {
      assert.equal(await blocked(gameSessionPeekBlock(tool, params, DM, none)), true, `${tool} ${JSON.stringify(params)}`);
    }
  });

  it("can't be read by its transcript id", async () => {
    assert.equal(await blocked(gameSessionPeekBlock("sessions_history", { sessionKey: "sess-game" }, DM, holding)), true);
    assert.equal(await blocked(gameSessionPeekBlock("sessions_history", { sessionKey: "sess-other" }, DM, holding)), false);
  });

  it("keeps reads across every session out while the agent holds a game session", async () => {
    const search = { query: "hold" };
    assert.equal(await blocked(gameSessionPeekBlock("sessions_search", search, DM, holding)), true);
    assert.equal(await blocked(gameSessionPeekBlock("sessions_search", search, DM, unknown)), true, "when it can't tell");
    assert.equal(await blocked(gameSessionPeekBlock("sessions_search", search, DM, none)), false);
    assert.equal(await blocked(gameSessionPeekBlock("sessions_list", { messageLimit: 3 }, DM, holding)), true);
    assert.equal(await blocked(gameSessionPeekBlock("sessions_list", { includeLastMessage: true }, DM, holding)), true);
  });

  it("leaves every other session tool call alone, without listing sessions", async () => {
    let listed = 0;
    const counting = async () => {
      listed += 1;
      return games;
    };
    assert.equal(gameSessionPeekBlock("sessions_list", {}, DM, counting), undefined, "keys and labels only");
    assert.equal(gameSessionPeekBlock("sessions_history", { sessionKey: "agent:main:clawbits:channel:dm-1" }, DM, counting), undefined);
    assert.equal(gameSessionPeekBlock("sessions_search", { query: "x", sessionKey: "agent:main:main" }, DM, counting), undefined);
    assert.equal(gameSessionPeekBlock("message", { sessionKey: GAME_KEY }, DM, counting), undefined);
    assert.equal(gameSessionPeekBlock("sessions_history", { sessionKey: GAME_KEY }, { sessionKey: GAME_KEY }, counting), undefined, "a game session's own tools are the allowlist's");
    assert.equal(listed, 0);
  });
});

/** OpenClaw's session store as the SDK shows it: SQLite (2026.8.1+), its lifecycle cleanup recorded. */
function sqliteStore(keys: string[], cleanup?: (params: Record<string, unknown>) => Promise<{ removedEntries: number }>) {
  const cleanups: Array<Record<string, unknown>> = [];
  return {
    cleanups,
    sdk: {
      listSessionEntries: () => keys.map((sessionKey, i) => ({ sessionKey, entry: { sessionId: `s${String(i)}` } })),
      deleteSessionEntry: async () => {
        throw new Error("archives nothing it deletes: never the way");
      },
      cleanupSessionLifecycleArtifacts: async (params: Record<string, unknown>) => {
        cleanups.push(params);
        return cleanup ? await cleanup(params) : { removedEntries: keys.filter((k) => k.includes(":widget-w1")).length };
      },
    },
  };
}

describe("a finished game's session", () => {
  const GEN_1 = `${GAME_KEY}-g1`;

  it("is deleted whole: every generation, transcripts included, nothing archived", async () => {
    const store = sqliteStore([GAME_KEY, GEN_1, "agent:main:clawbits:channel:widget-w2", "agent:main:main"]);
    __setSessionStoreForTest(store.sdk);
    const ctx = await makeCtx(async () => {});
    assert.equal(await endGameSession(ctx, "w1"), "deleted");
    assert.deepEqual(store.cleanups, [
      {
        agentId: "main",
        sessionKeySegmentPrefix: "clawbits:channel:widget-w1",
        transcriptContentMarker: GAME_TRANSCRIPT_MARKER,
        orphanTranscriptMinAgeMs: 0,
        archiveRemovedEntryTranscripts: false,
        pluginOwnerId: "clawbits",
      },
    ]);
  });

  it("waits while a run on its session still goes", async () => {
    const store = sqliteStore([GAME_KEY]);
    __setSessionStoreForTest(store.sdk);
    const ctx = await makeCtx(async () => {});
    trackGameRun("run-late", GAME_KEY, "start");
    assert.equal(await endGameSession(ctx, "w1"), "busy");
    assert.deepEqual(store.cleanups, [], "nothing deleted under the run");
    trackGameRun("run-late", GAME_KEY, "end");
    assert.equal(await endGameSession(ctx, "w1"), "deleted");
    assert.equal(store.cleanups.length, 1);
  });

  it("waits for a move still running on it", async () => {
    const store = sqliteStore([GAME_KEY]);
    __setSessionStoreForTest({
      ...store.sdk,
      // Small enough to stay in: the move runs in generation 0.
      listSessionEntries: () => [
        {
          sessionKey: GAME_KEY,
          entry: { sessionId: "s0", totalTokens: 9_000, totalTokensFresh: true, totalTokensVersion: 1, contextTokens: 200_000 },
        },
      ],
    });
    let during: string | undefined;
    const ctx: ChannelGatewayContext<ResolvedClawBitsAccount> = await makeCtx(async () => {
      during = await endGameSession(ctx, "w1");
    });
    await dispatchInboundMessage(ctx, MOVE, { client: new FakeClient() as unknown as ClawBitsClient });
    assert.equal(during, "busy");
    assert.deepEqual(store.cleanups, []);
    assert.equal(await endGameSession(ctx, "w1"), "deleted", "once the move settled");
  });

  it("waits when the store finds work in flight on it", async () => {
    const store = sqliteStore([GAME_KEY], async () => {
      throw new Error(`Cannot delete session while competing work is in flight for ${GAME_KEY}; retry after the run completes`);
    });
    __setSessionStoreForTest(store.sdk);
    const ctx = await makeCtx(async () => {});
    assert.equal(await endGameSession(ctx, "w1"), "busy");
  });

  it("is never deleted by a prefix that reaches another game", async () => {
    // Real widget ids are 32 hex characters; a shorter one could prefix another's.
    const store = sqliteStore([GAME_KEY, "agent:main:clawbits:channel:widget-w10"]);
    __setSessionStoreForTest(store.sdk);
    const ctx = await makeCtx(async () => {});
    assert.equal(await endGameSession(ctx, "w1"), "kept");
    assert.deepEqual(store.cleanups, []);
  });

  it("is deleted with every file of its transcripts from the file store (2026.6.10 to 2026.7)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawbits-game-files-"));
    try {
      const own = "0b9e1c1e-2a54-4d1c-9a51-6d1b6f0e8a01";
      const reset = "5f0c3c7a-9d1e-4b8a-8f0e-0c6a1d2b3c4d";
      const other = "7a1d2b3c-4d5e-4f60-8a71-b2c3d4e5f607";
      const files = [
        `${own}.jsonl`,
        `${own}-topic-3.jsonl`,
        `${own}.checkpoint.11111111-2222-4333-8444-555555555555.jsonl`,
        `${own}.trajectory.jsonl`,
        `${reset}.jsonl.reset.2026-10-01T04-00-00.000Z`,
        `${other}.jsonl`,
        "sessions.json",
      ];
      for (const name of files) await fs.writeFile(path.join(dir, name), "x");
      const sessions: Record<string, { sessionId: string; usageFamilySessionIds?: string[] }> = {
        [GAME_KEY]: { sessionId: own, usageFamilySessionIds: [reset, own] },
        "agent:main:main": { sessionId: other },
      };
      __setSessionStoreForTest({
        listSessionEntries: () => Object.entries(sessions).map(([sessionKey, entry]) => ({ sessionKey, entry })),
        resolveStorePath: () => path.join(dir, "sessions.json"),
        updateSessionStore: async (_storePath, mutator) => mutator(sessions),
      });
      const ctx = await makeCtx(async () => {});
      assert.equal(await endGameSession(ctx, "w1"), "deleted");
      assert.deepEqual(Object.keys(sessions), ["agent:main:main"]);
      assert.deepEqual((await fs.readdir(dir)).sort(), [`${other}.jsonl`, "sessions.json"].sort(), "no transcript, topic, checkpoint or archive left");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is kept, and said so once, where the host has no store a plugin can delete from", async () => {
    const warnings: string[] = [];
    __setSessionStoreForTest({
      listSessionEntries: () => [{ sessionKey: GAME_KEY, entry: { sessionId: "s0" } }],
    });
    const ctx = await makeCtx(async () => {});
    (ctx as { log?: unknown }).log = { info: () => {}, warn: (m: string) => warnings.push(m) };
    assert.equal(await endGameSession(ctx, "w1"), "kept");
    assert.equal(await endGameSession(ctx, "w1"), "kept");
    assert.equal(warnings.filter((m) => m.includes("not deleted")).length, 1, "one warning per session");
    assert.ok(warnings.every((m) => !m.includes("queen")), "no brief in the log");
  });

  it("never touches the main session", async () => {
    const store = sqliteStore(["agent:main:main"]);
    __setSessionStoreForTest(store.sdk);
    const ctx = await makeCtx(async () => {}, openClawRoute(true));
    assert.equal(await endGameSession(ctx, "w1"), "none");
    assert.deepEqual(store.cleanups, []);
  });
});

describe("a long game's session", () => {
  /** A store holding the game's generation 0, its last prompt at `totalTokens` of a 200k window. */
  function storeWithGame(totalTokens: number) {
    const store = sqliteStore([]);
    const sessions = new Map<string, Record<string, unknown>>([
      [GAME_KEY, { sessionId: "s0", totalTokens, totalTokensFresh: true, totalTokensVersion: 1, contextTokens: 200_000 }],
    ]);
    const sdk = {
      ...store.sdk,
      listSessionEntries: () => [...sessions].map(([sessionKey, entry]) => ({ sessionKey, entry })),
      cleanupSessionLifecycleArtifacts: async (params: Record<string, unknown>) => {
        store.cleanups.push(params);
        let removedEntries = 0;
        for (const key of [...sessions.keys()]) {
          if (key.split(":").slice(2).join(":").startsWith(String(params.sessionKeySegmentPrefix))) {
            sessions.delete(key);
            removedEntries += 1;
          }
        }
        return { removedEntries };
      },
    };
    return { cleanups: store.cleanups, sessions, sdk };
  }

  it("keeps its session while the next move stays under the memory flush", async () => {
    const store = storeWithGame(50_000);
    __setSessionStoreForTest(store.sdk);
    const route = openClawRoute();
    const ctx = await makeCtx(async () => {}, route);
    await dispatchInboundMessage(ctx, MOVE, { client: new FakeClient() as unknown as ClawBitsClient });
    assert.deepEqual(route.peers, [{ kind: "channel", id: "widget-w1" }]);
    assert.deepEqual(store.cleanups, []);
  });

  it("moves to a fresh session before it reaches the flush, deleting the old one first", async () => {
    const store = storeWithGame(150_000);
    __setSessionStoreForTest(store.sdk);
    const route = openClawRoute();
    const order: string[] = [];
    const turns: Array<Record<string, unknown>> = [];
    const ctx = await makeCtx(async ({ ctx: turn }) => {
      order.push(`dispatch with ${String(store.sessions.size)} session(s)`);
      turns.push(turn);
    }, route);
    await dispatchInboundMessage(ctx, MOVE, { client: new FakeClient() as unknown as ClawBitsClient });
    assert.deepEqual(store.cleanups.map((c) => c.sessionKeySegmentPrefix), ["clawbits:channel:widget-w1"]);
    assert.equal(store.cleanups[0]?.archiveRemovedEntryTranscripts, false);
    assert.deepEqual(order, ["dispatch with 0 session(s)"], "the old one is gone before the move runs");
    assert.deepEqual(turns[0]?.Peer, { kind: "channel", id: "widget-w1-g1" });
    assert.equal(turns[0]?.ConversationId, "widget-w1-g1");

    // The next move stays in generation 1 while it is small.
    store.sessions.set(`${GAME_KEY}-g1`, {
      sessionId: "s1",
      totalTokens: 30_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      contextTokens: 200_000,
    });
    await dispatchInboundMessage(ctx, { ...MOVE, postId: "widget-w1-r7-a1" }, { client: new FakeClient() as unknown as ClawBitsClient });
    assert.deepEqual(turns[1]?.Peer, { kind: "channel", id: "widget-w1-g1" });
    assert.equal(store.cleanups.length, 1);
  });
});

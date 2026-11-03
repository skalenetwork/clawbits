// A chat game's own session over a long game and after it (widgets/session.ts): generations, the
// rotation before OpenClaw's memory flush, the guard on memory runs, and the sweep of sessions
// whose game ended while the agent was away.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ClawBitsClient } from "../src/client.js";
import { ClawBitsError } from "../src/errors.js";
import { sweepGameSessions } from "../src/gateway-adapter.js";
import type { ResolvedClawBitsAccount } from "../src/types.js";
import {
  __resetGameSessionsForTest,
  __setSessionStoreForTest,
  GAME_TRANSCRIPT_MARKER,
  gameGenerationForMove,
  gameMemoryRunBlock,
  gamePeerId,
  gameRotationReason,
  gameSessionOf,
  gameSessionWidgetId,
  hostFlushesApart,
  isOwnGameSession,
  noteGameMove,
  registerGameTurnGuards,
  rotationTokenLimit,
  UNMEASURED_MOVES_PER_SESSION,
} from "../src/widgets/session.js";
import { wakeBody } from "../src/widgets/wake.js";

const KEY = "agent:main:clawbits:channel:widget-w1";

afterEach(() => {
  __resetGameSessionsForTest();
  __setSessionStoreForTest(undefined);
});

describe("a game session's generations", () => {
  it("key generation 0 as before and later ones with a suffix", () => {
    assert.equal(gamePeerId("w1"), "widget-w1");
    assert.equal(gamePeerId("w1", 0), "widget-w1");
    assert.equal(gamePeerId("w1", 3), "widget-w1-g3");
    assert.deepEqual(gameSessionOf(KEY), { widgetId: "w1", gen: 0 });
    assert.deepEqual(gameSessionOf(`${KEY}-g12`), { widgetId: "w1", gen: 12 });
    assert.equal(gameSessionOf("agent:main:clawbits:channel:dm-1"), undefined);
    assert.equal(gameSessionOf(`${KEY}:thread:1`), undefined);
  });

  it("all belong to their game, so its tools and guards hold in every one", () => {
    assert.equal(gameSessionWidgetId(`${KEY}-g2`), "w1");
    assert.equal(isOwnGameSession(`${KEY}-g2`, "w1"), true);
    assert.equal(isOwnGameSession(`${KEY}-g2`, "w1", 2), true);
    assert.equal(isOwnGameSession(`${KEY}-g2`, "w1", 0), false, "a move checks its own generation");
    assert.equal(isOwnGameSession(KEY, "w1", 0), true);
    assert.equal(isOwnGameSession(`${KEY}-g2`, "w2"), false);
  });

  it("carry the marker in every brief", () => {
    const body = wakeBody({
      widget_id: "w1",
      channel_id: "dm-1",
      kind: "chess",
      status: "active",
      rev: 5,
      seat: "black",
      waiting_on: ["black"],
      your_move: true,
      move_deadline: null,
      players: [],
      started_by: null,
      text: "board",
      legal: [],
      instructions: "Your move.",
      outcome: null,
    });
    assert.ok(body.split("\n")[0]?.includes(GAME_TRANSCRIPT_MARKER));
    assert.match(GAME_TRANSCRIPT_MARKER, /^[\x21-\x7e]+$/u, "printable ASCII: verbatim in stored JSON");
  });
});

describe("rotation before the memory flush", () => {
  it("rotates well under both flush thresholds", () => {
    // 200k window: the flush at 176k; rotation at 60% of the window.
    assert.equal(rotationTokenLimit(200_000), 120_000);
    // 128k window: the flush at 104k, less a 12.8k margin; 60% is lower.
    assert.equal(rotationTokenLimit(128_000), 76_800);
    // 64k: 2026.9.3+ flushes at 44k, earlier ones at 40k; less an 8k margin.
    assert.equal(rotationTokenLimit(64_000), 32_000);
    // A configured reserve only moves the older formula, and only earlier.
    assert.equal(rotationTokenLimit(200_000, { agents: { defaults: { compaction: { reserveTokensFloor: 90_000 } } } }), 86_000);
    // A window too small to hold a margin: every move in a session of its own.
    assert.ok(rotationTokenLimit(32_000) <= 0);
  });

  it("measures the session by its last prompt and window, the next brief included", () => {
    const usage = { totalTokens: 100_000, totalTokensFresh: true, contextTokens: 200_000 };
    assert.equal(gameRotationReason(usage, { briefChars: 3_000 }), undefined);
    assert.equal(gameRotationReason(usage, { briefChars: 60_000 }), "near the memory flush");
    assert.equal(gameRotationReason({ ...usage, totalTokens: 120_000 }, { briefChars: 0 }), "near the memory flush");
  });

  it("falls back on a move count where the size can't be measured", () => {
    const stale = { totalTokens: 10_000, totalTokensFresh: false, contextTokens: 200_000 };
    assert.equal(gameRotationReason(stale, { moves: UNMEASURED_MOVES_PER_SESSION - 1, briefChars: 0 }), undefined);
    assert.equal(gameRotationReason(stale, { moves: UNMEASURED_MOVES_PER_SESSION, briefChars: 0 }), "size unmeasured");
    assert.equal(gameRotationReason({ totalTokens: 10_000, totalTokensVersion: 2, contextTokens: 200_000 }, { moves: 0, briefChars: 0 }), undefined);
    assert.equal(gameRotationReason({ totalTokens: 10_000 }, { moves: 3, briefChars: 0 }), undefined, "no window: counted");
    assert.equal(gameRotationReason({}, { briefChars: 0 }), "size unmeasured", "moves before this process: unknown, so rotate");
  });

  it("takes a count for fresh only as OpenClaw does: flagged fresh, and version 1 where the host versions it", () => {
    const unflagged = { totalTokens: 10_000, contextTokens: 200_000 };
    assert.equal(gameRotationReason(unflagged, { briefChars: 0 }), "size unmeasured");
    assert.equal(gameRotationReason(unflagged, { moves: 3, briefChars: 0 }), undefined, "counted instead");
    const versioned = { ...unflagged, totalTokensFresh: true, tokensVersioned: true };
    assert.equal(gameRotationReason(versioned, { briefChars: 0 }), "size unmeasured", "2026.8.1+: no version, stale");
    assert.equal(gameRotationReason({ ...versioned, totalTokensVersion: 1 }, { briefChars: 0 }), undefined);
    assert.equal(gameRotationReason({ ...unflagged, totalTokensFresh: true }, { briefChars: 0 }), undefined, "before 2026.8.1");
  });

  it("rotates a session whose next move runs on a model other than its last run's", async () => {
    // 115k of a 200k window stays under the 120k limit; a 128k model flushes at 104k.
    const entry = {
      sessionId: "s0",
      totalTokens: 115_000,
      totalTokensFresh: true,
      contextTokens: 200_000,
      modelProvider: "anthropic",
      model: "claude-big",
    };
    let agentDefault = { provider: "anthropic", model: "claude-big" };
    __setSessionStoreForTest({
      listSessionEntries: () => [{ sessionKey: KEY, entry }],
      resolveSessionModelRef: () => agentDefault,
    });
    const move = (choice?: { model: string | null; thinking: string | null }) =>
      gameGenerationForMove({ sessionKey: KEY, agentId: "main", widgetId: "w1", briefChars: 100, cfg: {}, ...(choice ? { choice } : {}) });
    assert.equal((await move()).gen, 0, "the same model: kept");
    assert.equal((await move({ model: "anthropic/claude-big", thinking: null })).gen, 0, "the chat chose the same model");
    const chosen = await move({ model: "openai/gpt-small", thinking: null });
    assert.deepEqual([chosen.gen, chosen.rotated], [1, "the model changed"], "the chat chose another model");
    __resetGameSessionsForTest();
    agentDefault = { provider: "openai", model: "gpt-small" };
    const inherited = await move({ model: null, thinking: null });
    assert.deepEqual([inherited.gen, inherited.rotated], [1, "the model changed"], "the agent's default changed");
  });

  it("counts moves where the store's list never shows the session, and rotates after the last one", async () => {
    __setSessionStoreForTest({ listSessionEntries: () => [] });
    const params = { sessionKey: KEY, agentId: "main", widgetId: "w1", briefChars: 100 };
    for (let move = 0; move < UNMEASURED_MOVES_PER_SESSION; move += 1) {
      assert.equal((await gameGenerationForMove(params)).gen, 0);
      noteGameMove(KEY);
    }
    const rotated = await gameGenerationForMove(params);
    assert.deepEqual([rotated.gen, rotated.rotated], [1, "size unmeasured"]);
  });

  it("lists the store `session.store` names, as deletion does", async () => {
    const listed: unknown[] = [];
    __setSessionStoreForTest({
      // OpenClaw names the default agent's store where no agent is given.
      resolveStorePath: (store, opts) => (store ?? "/default").replace("{agentId}", opts?.agentId ?? "main"),
      listSessionEntries: (params) => {
        listed.push(params?.storePath);
        return [];
      },
    });
    const cfg = { session: { store: "/stores/{agentId}/sessions.json" } };
    await gameGenerationForMove({ sessionKey: KEY, agentId: "main", widgetId: "w1", briefChars: 100, cfg });
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    registerGameTurnGuards({
      config: cfg,
      on: (hook: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(hook, handler),
    } as unknown as OpenClawPluginApi);
    await handlers.get("before_tool_call")?.(
      { toolName: "sessions_search", params: {} },
      { toolName: "sessions_search", sessionKey: "agent:main:main", agentId: "main" },
    );
    assert.ok(listed.length >= 2, "a move's rotation, then the peek guard");
    assert.deepEqual(new Set(listed), new Set(["/stores/main/sessions.json"]));
  });

  it("rotates a session that compacted, flushed or grew a large transcript", () => {
    const small = { totalTokens: 10_000, totalTokensFresh: true, contextTokens: 200_000 };
    assert.equal(gameRotationReason({ ...small, compactionCount: 1 }, { briefChars: 0 }), "compacted");
    assert.equal(gameRotationReason({ ...small, flushed: true }, { briefChars: 0 }), "a memory flush ran");
    assert.equal(gameRotationReason({ ...small, transcriptBytes: 1024 * 1024 }, { briefChars: 0 }), "transcript size");
    assert.equal(gameRotationReason({ ...small, transcriptBytes: 300 * 1024 }, { briefChars: 0 }), undefined);
    const lowForce = { agents: { defaults: { compaction: { memoryFlush: { forceFlushTranscriptBytes: "512kb" } } } } };
    assert.equal(gameRotationReason({ ...small, transcriptBytes: 300 * 1024 }, { briefChars: 0, cfg: lowForce }), "transcript size");
  });

  it("rotates a session OpenClaw's reset policy would reset on the next move", async () => {
    const asked: unknown[] = [];
    let fresh = true;
    __setSessionStoreForTest({
      listSessionEntries: () => [
        {
          sessionKey: KEY,
          entry: { sessionId: "s0", totalTokens: 9_000, totalTokensFresh: true, contextTokens: 200_000, updatedAt: 5, sessionStartedAt: 2 },
        },
      ],
      resolveSessionResetType: ({ sessionKey, isGroup }) => {
        asked.push({ sessionKey, isGroup });
        return "group";
      },
      resolveChannelResetConfig: ({ channel }) => {
        asked.push({ channel });
        return undefined;
      },
      resolveSessionResetPolicy: ({ resetType }) => {
        asked.push({ resetType });
        return { mode: "daily", atHour: 4 };
      },
      evaluateSessionFreshness: ({ updatedAt, sessionStartedAt }) => {
        asked.push({ updatedAt, sessionStartedAt });
        return { fresh };
      },
    });
    const params = { sessionKey: KEY, agentId: "main", widgetId: "w1", briefChars: 10 };
    assert.equal((await gameGenerationForMove(params)).gen, 0, "fresh: kept");
    assert.deepEqual(asked, [
      { sessionKey: KEY, isGroup: true },
      { channel: "clawbits" },
      { resetType: "group" },
      { updatedAt: 5, sessionStartedAt: 2 },
    ]);
    fresh = false;
    const next = await gameGenerationForMove(params);
    assert.equal(next.gen, 1);
    assert.equal(next.rotated, "a session reset is due");
  });

  it("counts moves where the host can't list its sessions, and rotates after the last one", async () => {
    __setSessionStoreForTest({});
    const params = { sessionKey: KEY, agentId: "main", widgetId: "w1", briefChars: 100 };
    for (let move = 0; move < UNMEASURED_MOVES_PER_SESSION; move += 1) {
      assert.equal((await gameGenerationForMove(params)).gen, 0);
      noteGameMove(KEY);
    }
    const rotated = await gameGenerationForMove(params);
    assert.equal(rotated.gen, 1);
    assert.equal(rotated.rotated, "size unmeasured");
    assert.equal(rotated.deleted, "kept", "nothing to delete it with");
    noteGameMove(`${KEY}-g1`);
    assert.equal((await gameGenerationForMove(params)).gen, 1);
  });

  it("picks up the newest generation after a restart and rotates it when it can't be measured", async () => {
    const cleanups: string[] = [];
    __setSessionStoreForTest({
      listSessionEntries: () => [
        { sessionKey: `${KEY}-g3`, entry: { sessionId: "s3" } },
        { sessionKey: "agent:main:main", entry: { sessionId: "m" } },
      ],
      deleteSessionEntry: async () => false,
      cleanupSessionLifecycleArtifacts: async ({ sessionKeySegmentPrefix }) => {
        cleanups.push(sessionKeySegmentPrefix);
        return { removedEntries: 1 };
      },
    });
    const next = await gameGenerationForMove({ sessionKey: KEY, agentId: "main", widgetId: "w1", briefChars: 100 });
    assert.deepEqual(next, { gen: 4, rotated: "size unmeasured", deleted: "deleted" });
    assert.deepEqual(cleanups, ["clawbits:channel:widget-w1-g3"]);
  });
});

describe("a memory run over a game's transcript", () => {
  const block = (messages: unknown, ctx: { trigger?: string; sessionKey?: string }) =>
    gameMemoryRunBlock({ messages }, ctx)?.outcome;

  it("is refused, wherever it runs", () => {
    const game = [{ role: "user", content: [{ type: "text", text: `[Clawbits chat game · poker · ${GAME_TRANSCRIPT_MARKER}]` }] }];
    assert.equal(block(game, { trigger: "memory", sessionKey: "agent:main:internal-session-effects:ab12" }), "block");
    assert.equal(block([], { trigger: "memory", sessionKey: KEY }), "block", "inline on the game's key (up to 2026.9.2)");
  });

  it("leaves every other run alone", () => {
    const game = [{ role: "user", content: GAME_TRANSCRIPT_MARKER }];
    assert.equal(block(game, { trigger: "user", sessionKey: KEY }), undefined, "a move itself");
    assert.equal(block([{ role: "user", content: "hello" }], { trigger: "memory", sessionKey: "agent:main:main" }), undefined);
  });

  it("is guarded only where the flush runs apart, or the host's version can't be told", () => {
    const hooks = (version?: string) => {
      const registered: string[] = [];
      registerGameTurnGuards({
        ...(version ? { runtime: { version } } : {}),
        on: (hook: string) => registered.push(hook),
      } as unknown as OpenClawPluginApi);
      return registered.includes("before_agent_run");
    };
    assert.equal(hooks("2026.9.2"), false, "the tool guard holds the flush in the game's own session");
    assert.equal(hooks("2026.6.10"), false);
    assert.equal(hooks("2026.9.3"), true);
    assert.equal(hooks("2026.10.2-beta.1"), true);
    assert.equal(hooks("2027.1.0"), true);
    assert.equal(hooks("unknown"), true);
    assert.equal(hooks(), true);
    assert.equal(hostFlushesApart("v2026.9.4"), true);
  });
});

describe("the sweep of ended games' sessions", () => {
  /** The agent's store: its sessions, by key; the lifecycle cleanup removes what a prefix reaches. */
  function store(keys: string[]) {
    const sessions = new Set(keys);
    const prefixes: string[] = [];
    __setSessionStoreForTest({
      listSessionEntries: () => [...sessions].map((sessionKey) => ({ sessionKey, entry: { sessionId: sessionKey } })),
      deleteSessionEntry: async () => false,
      cleanupSessionLifecycleArtifacts: async ({ sessionKeySegmentPrefix }) => {
        prefixes.push(sessionKeySegmentPrefix);
        let removedEntries = 0;
        for (const key of sessions) {
          if (key.split(":").slice(2).join(":").startsWith(sessionKeySegmentPrefix)) {
            sessions.delete(key);
            removedEntries += 1;
          }
        }
        return { removedEntries };
      },
    });
    return { sessions, prefixes };
  }

  const key = (peer: string) => `agent:main:clawbits:channel:${peer}`;

  function makeCtx(): ChannelGatewayContext<ResolvedClawBitsAccount> {
    return {
      cfg: {},
      accountId: "default",
      channelRuntime: {
        routing: {
          resolveAgentRoute: ({ peer }: { peer: { id: string } }) => ({ agentId: "main", sessionKey: key(peer.id) }),
        },
      },
    } as unknown as ChannelGatewayContext<ResolvedClawBitsAccount>;
  }

  /** The agent widget routes: `active` in the list, `status` (or an HTTP error) per game read. */
  function server(active: string[], games: Record<string, string | number>) {
    const reads: string[] = [];
    const client = {
      encodePath: (...parts: string[]) => parts.map(encodeURIComponent).join("/"),
      request: async (_method: string, path: string) => {
        if (path === "/api/agentic/mm/widgets") return { widgets: active.map((widget_id) => ({ widget_id })) };
        const id = /widgets\/([^/?]+)/u.exec(path)?.[1] ?? "";
        reads.push(id);
        const answer = games[id];
        if (typeof answer === "number") throw new ClawBitsError({ statusCode: answer, detail: "", path });
        return { widget_id: id, status: answer, text: "You hold the queen of spades" };
      },
    } as unknown as ClawBitsClient;
    return { client, reads };
  }

  it("deletes the sessions of games that ended or are out of reach, and only those", async () => {
    const s = store([
      key("widget-wplaying"),
      key("widget-wfinished"),
      key("widget-wfinished-g1"),
      key("widget-wgone"),
      key("widget-wdown"),
      key("widget-wstill"),
      "agent:main:main",
    ]);
    const { client, reads } = server(["wplaying"], { wfinished: "finished", wgone: 404, wdown: 503, wstill: "active" });
    let serialRuns = 0;
    await sweepGameSessions(makeCtx(), client, async (run) => {
      serialRuns += 1;
      await run();
    });
    assert.deepEqual([...s.sessions].sort(), [key("widget-wdown"), key("widget-wplaying"), key("widget-wstill"), "agent:main:main"].sort());
    assert.deepEqual(reads.sort(), ["wdown", "wfinished", "wgone", "wstill"], "no read for a listed active game");
    assert.equal(serialRuns, 2, "each deletion on the queue");
  });

  it("deletes an active game's older generations, and all of its sessions where one can't go alone", async () => {
    const s = store([
      key("widget-wa"),
      key("widget-wa-g1"),
      key("widget-wa-g2"),
      key("widget-wb-g1"),
      key("widget-wb-g12"),
      key("widget-wc-g1"),
      key("widget-wc-g2"),
    ]);
    const { client } = server(["wa", "wb", "wc"], {});
    await sweepGameSessions(makeCtx(), client);
    assert.deepEqual(
      s.prefixes,
      ["clawbits:channel:widget-wa", "clawbits:channel:widget-wb", "clawbits:channel:widget-wc-g1"],
      "generation 0 and wb's g1 reach a later one: their game's next move starts afresh",
    );
    assert.deepEqual([...s.sessions], [key("widget-wc-g2")]);
    await sweepGameSessions(makeCtx(), client);
    assert.equal(s.prefixes.length, 3, "nothing left to retry");
  });

  it("takes a game it can't reach for over only if it sat in it, where another account routes to the agent", async () => {
    const s = store([key("widget-wmine"), key("widget-wtheirs")]);
    const { client } = server([], { wmine: 404, wtheirs: 404 });
    const ctx = makeCtx();
    (ctx as { cfg: unknown }).cfg = { channels: { clawbits: { accounts: { default: {}, other: {} } } } };
    await sweepGameSessions(ctx, client, undefined, undefined, (widgetId) => widgetId === "wmine");
    assert.deepEqual([...s.sessions], [key("widget-wtheirs")], "the other account's game keeps its session");
  });

  it("deletes nothing where the server can't say which games ended", async () => {
    const s = store([key("widget-wx")]);
    const client = {
      encodePath: encodeURIComponent,
      request: async (_method: string, path: string) => {
        throw new ClawBitsError({ statusCode: 404, detail: "Not Found", path });
      },
    } as unknown as ClawBitsClient;
    await sweepGameSessions(makeCtx(), client);
    assert.deepEqual(s.prefixes, []);
    assert.equal(s.sessions.size, 1);
  });
});

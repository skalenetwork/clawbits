import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/core";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { ClawBitsClient } from "../src/client.js";
import {
  __resetDraftRegistryForTest,
  openTurnContext,
  registerOpenDraft,
  unregisterOpenDraft,
  type OpenDraftRef,
} from "../src/draft-registry.js";
import { dispatchInboundMessage } from "../src/gateway-adapter.js";
import { withInboundDispatchGuard } from "../src/inbound-dispatch-guard.js";
import { outboundAdapter } from "../src/outbound-adapter.js";
import { __resetQuestionsForTest, questionSurface, questionWaiting, type QuestionCard } from "../src/questions.js";
import { type PluginRuntime, setRuntime } from "../src/runtime.js";
import type { ResolvedClawBitsAccount } from "../src/types.js";
import { memoryState, type memoryStore } from "./runtime-state.js";

const CHANNEL = "916abcc5-5eb2-4bb9-9ff6-b3b5b7070b4d";
const QID = `ask_${"a".repeat(32)}`;
const GUIDANCE = "- Staging\n- Production\n\nReply with the number, the option text, or your own answer.";

/** Core's ask_user presentation (buildAgentHarnessQuestionPresentation) for one question with a custom answer. */
const ASK: MessagePresentation = {
  blocks: [
    { type: "text", text: "Deploy where?" },
    { type: "text", text: GUIDANCE },
    {
      type: "buttons",
      buttons: [
        { label: "Staging", action: { type: "question", questionId: QID, optionValue: "staging" } },
        { label: "Production", action: { type: "question", questionId: QID, optionValue: "production" } },
        { label: "Other…", action: { type: "question", questionId: QID, intent: "custom-input" } },
      ],
    },
  ],
};

const option = (label: string, optionValue: string) => ({
  label,
  action: { type: "question" as const, questionId: QID, optionValue },
});

function cfg() {
  return {
    channels: {
      clawbits: {
        accounts: {
          default: { endpoint: "http://fc", orgId: "org-1", agentId: "bot", apiKey: "k", channelId: CHANNEL },
        },
      },
    },
  } as never;
}

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

/** A Clawbits server that mints post ids from 1001, refusing surfaces when asked to. */
function installServer(opts: { refuseSurfaces?: boolean } = {}): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  let ids = 1000;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const { pathname: path } = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/auth/challenge")) {
      return reply({ challenge: "What is the capital of France?", session_token: "tok" });
    }
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ method, path, body });
    if (method === "POST" && path.endsWith("/posts")) {
      if (opts.refuseSurfaces && body.surface) return reply({ detail: [{ message: "A Button's child is a Text." }] }, 422);
      return reply({ post_id: (ids += 1), channel_id: CHANNEL, message: "", status: body.status ?? "published" });
    }
    return reply({ post_id: 777, channel_id: CHANNEL, message: "", status: "published" });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

type Delivery = Parameters<typeof questionGatewayRuntime.registerChannelDelivery>[0];
const original = { ...questionGatewayRuntime };

describe("questionSurface", () => {
  it("maps core's ask_user prompt to a card: its text, a button per option and a hint to type an answer", () => {
    const event = (optionValue: string) => ({ event: { name: "oc.question", context: { optionValue } } });
    assert.deepEqual(questionSurface(ASK), {
      surface: {
        components: [
          { id: "root", component: "Column", children: ["c0", "c1", "c6", "c7"] },
          { id: "c0", component: "Text", text: "Deploy where?" },
          { id: "c1", component: "Text", text: GUIDANCE },
          { id: "c2", component: "Text", text: "Staging" },
          { id: "c3", component: "Button", child: "c2", action: event("staging") },
          { id: "c4", component: "Text", text: "Production" },
          { id: "c5", component: "Button", child: "c4", action: event("production") },
          { id: "c6", component: "Row", children: ["c3", "c5"] },
          { id: "c7", component: "Text", text: "Or type your own answer.", variant: "caption" },
        ],
        once: false,
      },
      fallback: `Deploy where?\n\n${GUIDANCE}`,
    });
  });

  it("makes the title a bold Text and a context block a caption", () => {
    const card = questionSurface({
      title: "Release",
      blocks: [{ type: "context", text: "Asked by the deploy run" }, { type: "buttons", buttons: [option("Ship", "ship")] }],
    });
    assert.deepEqual(card?.surface.components.slice(1, 3), [
      { id: "c0", component: "Text", text: "**Release**" },
      { id: "c1", component: "Text", text: "Asked by the deploy run", variant: "caption" },
    ]);
    assert.equal(card?.fallback, "Release\n\nAsked by the deploy run");
  });

  it("leaves anything else to core's text", () => {
    const refused: MessagePresentation[] = [
      { blocks: [{ type: "divider" }] },
      { blocks: [{ type: "select", options: [{ label: "Staging", value: "staging" }] }] },
      { blocks: [{ type: "buttons", buttons: [{ label: "Open link", action: { type: "url", url: "https://example.com" } }] }] },
      { blocks: [{ type: "buttons", buttons: [{ label: "Staging", value: "staging" }] }] },
      { blocks: [{ type: "buttons", buttons: [option("/reset", "reset")] }] },
      { blocks: [{ type: "buttons", buttons: [option("Ask @ops", "ops")] }] },
      { blocks: [{ type: "buttons", buttons: [option("See https://x.dev", "x")] }] },
    ];
    for (const presentation of refused) assert.equal(questionSurface(presentation), null, JSON.stringify(presentation));
  });
});

describe("outboundAdapter.renderPresentation", () => {
  const render = (channelData?: Record<string, unknown>, presentation = ASK) =>
    outboundAdapter.renderPresentation({ payload: { ...(channelData ? { channelData } : {}) }, presentation, ctx: {} as never });

  it("carries an ask_user prompt's card to sendPayload, next to core's marker", () => {
    const askUser = { questionId: QID, optionValues: ["staging", "production"] };
    const card = questionSurface(ASK);
    assert.deepEqual(render({ askUser }), { channelData: { askUser, clawbits: { questionId: QID, ...card } } });
  });

  it("renders nothing for a presentation without core's marker, or one no card can show", () => {
    assert.equal(render(), null);
    assert.equal(render({ other: true }), null);
    assert.equal(render({ askUser: { questionId: QID } }, { blocks: [{ type: "divider" }] }), null);
  });
});

describe("outboundAdapter.sendPayload", () => {
  let state = memoryState();
  const bindings = () =>
    (state.openKeyedStore({ namespace: "ui-questions", maxEntries: 1 }) as unknown as ReturnType<typeof memoryStore<string>>).rows;
  const card = { questionId: QID, ...questionSurface(ASK)! } satisfies QuestionCard;
  const deliveries: Delivery[] = [];
  const send = (channelData: Record<string, unknown>, text = "") =>
    outboundAdapter.sendPayload({
      cfg: cfg(),
      to: CHANNEL,
      text,
      payload: { text, channelData },
      deliveryQueueId: "q1",
      deliveryPartIndex: 0,
    } as never);
  const draftCreates = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.body.status === "streaming");

  beforeEach(() => {
    state = memoryState();
    setRuntime({ config: { current: cfg }, state } as unknown as PluginRuntime);
    __resetDraftRegistryForTest();
    __resetQuestionsForTest();
    deliveries.length = 0;
    questionGatewayRuntime.registerChannelDelivery = (delivery) => void deliveries.push(delivery);
  });

  afterEach(() => {
    Object.assign(questionGatewayRuntime, original);
  });

  it("posts the card with the delivery key and the turn's trace, ends the turn's draft and opens none", async () => {
    const server = installServer();
    const ref: OpenDraftRef = { id: 777, traceId: "trace-1" };
    registerOpenDraft("default", CHANNEL, ref);
    try {
      const sent = await send({ askUser: { questionId: QID }, clawbits: card });
      assert.equal(sent.messageId, "1001");
      assert.deepEqual(server.calls[0], {
        method: "POST",
        path: `/api/agentic/mm/channels/${CHANNEL}/posts`,
        body: { surface: card.surface, client_key: "q1:0", trace_id: "trace-1" },
      });
      assert.deepEqual(
        server.calls.slice(1).map((c) => [c.method, c.path, c.body]),
        [
          ["PATCH", `/api/agentic/mm/channels/${CHANNEL}/posts/777`, { cancel: true }],
          ["POST", `/api/agentic/mm/channels/${CHANNEL}/status`, { status: "online" }],
        ],
      );
      assert.equal(ref.id, undefined);
      assert.deepEqual(draftCreates(server.calls), []);
      assert.deepEqual([...bindings()], [[`default:1001`, { channelId: CHANNEL, questionId: QID }]]);
      assert.equal(questionWaiting("default", CHANNEL), true);
      assert.deepEqual(deliveries.map(({ questionId, deliveryId }) => [questionId, deliveryId]), [[QID, "1001"]]);
    } finally {
      server.restore();
    }
  });

  it("closes the card with core's status line once the question ends, and the turn goes on in a fresh draft", async () => {
    const server = installServer();
    const ref: OpenDraftRef = { id: 777, traceId: "trace-1" };
    registerOpenDraft("default", CHANNEL, ref);
    try {
      await send({ askUser: { questionId: QID }, clawbits: card });
      const before = server.calls.length;
      await deliveries[0]!.finalize("Answered: Production");
      assert.deepEqual(
        server.calls.slice(before).map((c) => [c.method, c.path, c.body]),
        [
          ["POST", "/api/agentic/mm/posts/1001/ui/close", { text: "Answered: Production" }],
          ["POST", `/api/agentic/mm/channels/${CHANNEL}/posts`, { message: "", status: "streaming", trace_id: "trace-1" }],
        ],
      );
      assert.equal(questionWaiting("default", CHANNEL), false);
      assert.deepEqual([...bindings()], []);
      assert.equal(ref.id, 1002);
      assert.equal(openTurnContext("default", CHANNEL), ref);
    } finally {
      server.restore();
    }
  });

  it("cancels the fresh draft at once when the turn ended before its question did", async () => {
    const server = installServer();
    const ref: OpenDraftRef = { id: 777, traceId: "trace-1" };
    registerOpenDraft("default", CHANNEL, ref);
    try {
      await send({ askUser: { questionId: QID }, clawbits: card });
      unregisterOpenDraft("default", CHANNEL, ref);
      await deliveries[0]!.finalize("Cancelled");
      assert.deepEqual(server.calls.at(-1), {
        method: "PATCH",
        path: `/api/agentic/mm/channels/${CHANNEL}/posts/1002`,
        body: { cancel: true },
      });
      assert.equal(ref.id, undefined);
    } finally {
      server.restore();
    }
  });

  it("sends the question as text when the server refuses the card, still waiting on it", async () => {
    const server = installServer({ refuseSurfaces: true });
    const ref: OpenDraftRef = { id: 777, traceId: "trace-1" };
    registerOpenDraft("default", CHANNEL, ref);
    try {
      const sent = await send({ askUser: { questionId: QID }, clawbits: card });
      assert.deepEqual(
        server.calls.slice(1, 3).map((c) => [c.method, c.path, c.body]),
        [
          ["POST", `/api/agentic/mm/channels/${CHANNEL}/posts`, { message: card.fallback, client_key: "q1:0", trace_id: "trace-1" }],
          ["PATCH", `/api/agentic/mm/channels/${CHANNEL}/posts/777`, { cancel: true }],
        ],
      );
      assert.deepEqual([...bindings()], []);
      assert.equal(questionWaiting("default", CHANNEL), true);
      assert.deepEqual(deliveries.map(({ deliveryId }) => deliveryId), [sent.messageId]);
      const before = server.calls.length;
      await deliveries[0]!.finalize("Answered");
      assert.deepEqual(
        server.calls.slice(before).map((c) => c.path),
        [`/api/agentic/mm/channels/${CHANNEL}/posts`],
        "no card to close, only the fresh draft",
      );
      assert.equal(questionWaiting("default", CHANNEL), false);
    } finally {
      server.restore();
    }
  });

  it("sends any other payload as its text", async () => {
    const server = installServer();
    try {
      await send({ telegram: { silent: true } }, "Done.");
      assert.deepEqual(server.calls.map((c) => c.body), [{ message: "Done.", client_key: "q1:0" }]);
      assert.equal(questionWaiting("default", CHANNEL), false);
      assert.deepEqual(deliveries, []);
    } finally {
      server.restore();
    }
  });
});

describe("dispatchInboundMessage for a typed answer", () => {
  const SESSION = "agent:main:clawbits:direct:human:1";

  function makeCtx(dispatched: Array<Record<string, unknown>>): ChannelGatewayContext<ResolvedClawBitsAccount> {
    return {
      cfg: { channels: { clawbits: { endpoint: "http://fc", agentId: "bot-agent", apiKey: "k1", channelId: "chan-1" } } },
      accountId: "default",
      account: { accountId: "default", agentId: "bot-agent", channelId: "chan-1", streaming: true, liveActivity: true },
      abortSignal: new AbortController().signal,
      channelRuntime: {
        routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: SESSION }) },
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async ({ ctx }: { ctx: Record<string, unknown> }) =>
            void dispatched.push(ctx),
        },
      },
    } as unknown as ChannelGatewayContext<ResolvedClawBitsAccount>;
  }

  it("hands core the raw text while the asking turn holds the session, opening nothing of its own", async () => {
    __resetDraftRegistryForTest();
    const server = installServer();
    const asking: OpenDraftRef = { id: undefined, traceId: "trace-1" };
    registerOpenDraft("default", "chan-1", asking);
    let release!: () => void;
    const held = withInboundDispatchGuard({ sessionKey: SESSION }, () => new Promise<void>((resolve) => (release = resolve)));
    const dispatched: Array<Record<string, unknown>> = [];
    try {
      await dispatchInboundMessage(
        makeCtx(dispatched),
        {
          accountId: "default",
          channelId: "chan-1",
          postId: "102",
          senderId: "human:1",
          text: "staging",
          files: [],
          channelType: "direct",
          createAt: 1,
          questionAnswer: true,
        },
        { client: new ClawBitsClient({ endpoint: "http://fc", apiKey: "k1" }), answers: {} },
      );
      assert.equal(dispatched.length, 1, "dispatched while the guard is held");
      assert.equal(dispatched[0]?.Body, "staging");
      assert.equal(dispatched[0]?.BodyForAgent, "staging");
      assert.deepEqual(server.calls.filter((c) => c.path.startsWith("/api/agentic/")), [], "no draft, no status");
      assert.equal(openTurnContext("default", "chan-1"), asking);
    } finally {
      release();
      await held;
      server.restore();
    }
  });
});

// Minimal stand-in for `openclaw/plugin-sdk/channel-outbound`. The real SDK
// export builds a `ChannelMessageAdapter` that the host's codex/agent bridge
// uses to deliver `tools.message` / `agent_message` output to channel plugins.
// Tests in this package do not exercise that bridge end-to-end, so the stub
// only needs to be callable and return a value the channel plugin can hand
// back to the host under its `message:` slot.

export interface CreateChannelMessageAdapterFromOutboundParams<TCfg = unknown> {
  id: string;
  live?: {
    capabilities?: Record<string, boolean>;
    finalizer?: {
      capabilities?: Record<string, boolean>;
    };
  };
  receive?: {
    defaultAckPolicy?: string;
    supportedAckPolicies?: readonly string[];
  };
  outbound: unknown;
  // Carry the config type through so callers can keep their generic for parity
  // with the real SDK signature; we never inspect it here.
  __cfg?: TCfg;
}

export function createChannelMessageAdapterFromOutbound<TCfg = unknown>(
  params: CreateChannelMessageAdapterFromOutboundParams<TCfg>,
): Record<string, unknown> {
  return {
    id: params.id,
    live: params.live,
    receive: params.receive,
    outbound: params.outbound,
  };
}

interface StubLifecycle {
  abortSignal: AbortSignal;
  admission: "exclusive";
  deferredHeartbeatIntervalMs: number;
  onAdopted: () => Promise<void>;
  onDeferred: () => void;
  onDeferredHeartbeat: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => Promise<void>;
}

interface StubMonitorOptions<TRaw> {
  inspect: (
    raw: TRaw,
    context: { phase: "admission" } | { phase: "claim"; claimedLaneKey: string },
  ) => { eventId: string; laneKey: string } | null;
  deliver: (raw: TRaw, lifecycle: StubLifecycle, claim: { id: string; attempts: number }) => unknown;
  drain?: { retryPolicy?: { maxAttempts?: number } };
  onError?: (error: unknown) => void;
}

export function createChannelIngressMonitor<TRaw>(options: StubMonitorOptions<TRaw>) {
  const ids = new Set<string>();
  const lanes = new Map<string, Promise<void>>();
  const maxAttempts = options.drain?.retryPolicy?.maxAttempts ?? 8;
  const run = (raw: TRaw, facts: { eventId: string; laneKey: string }, attempts: number): void => {
    const task = (lanes.get(facts.laneKey) ?? Promise.resolve()).then(async () => {
      let adopted = false;
      const lifecycle: StubLifecycle = {
        abortSignal: new AbortController().signal,
        admission: "exclusive",
        deferredHeartbeatIntervalMs: 60_000,
        onAdopted: async () => {
          adopted = true;
        },
        onDeferred: () => {},
        onDeferredHeartbeat: () => {},
        onAdoptionFinalizing: () => {},
        onAbandoned: async () => {},
      };
      try {
        if (options.inspect(raw, { phase: "claim", claimedLaneKey: facts.laneKey })?.laneKey !== facts.laneKey) {
          throw new Error(`inbound event ${facts.eventId}: identity-mismatch`);
        }
        await options.deliver(raw, lifecycle, { id: facts.eventId, attempts });
      } catch (error) {
        if (!adopted && attempts + 1 < maxAttempts) queueMicrotask(() => run(raw, facts, attempts + 1));
        else options.onError?.(error);
      }
    });
    lanes.set(facts.laneKey, task.catch(() => undefined));
  };
  return {
    admit: async (raw: TRaw) => {
      const facts = options.inspect(raw, { phase: "admission" });
      if (!facts) return { kind: "ignored" as const };
      if (ids.has(facts.eventId)) {
        return { kind: "durable" as const, queueResult: { kind: "completed" as const, duplicate: true as const } };
      }
      ids.add(facts.eventId);
      run(raw, facts, 0);
      return { kind: "durable" as const, queueResult: { kind: "accepted" as const, duplicate: false as const } };
    },
    start: () => {},
    stop: async () => {
      await Promise.all(lanes.values());
    },
    waitForIdle: async () => {
      await Promise.all(lanes.values());
    },
  };
}

export function bindIngressLifecycleToReplyOptions<T extends object>(lifecycle: T) {
  return { turnAdoptionLifecycle: { ...lifecycle, admission: "exclusive" as const } };
}

let intents = 0;

export async function sendDurableMessageBatch(params: {
  cfg: unknown;
  to: string;
  accountId?: string;
  payloads: Array<{ text?: string; mediaUrl?: string }>;
}) {
  const { outboundAdapter } = await import("../../../outbound-adapter.js");
  const deliveryQueueId = `test-intent-${String((intents += 1))}`;
  try {
    const results = [];
    for (const [index, payload] of params.payloads.entries()) {
      const ctx = {
        cfg: params.cfg,
        to: params.to,
        accountId: params.accountId,
        text: payload.text ?? "",
        deliveryQueueId,
        deliveryPartIndex: index,
      } as never;
      results.push(await (payload.mediaUrl ? outboundAdapter.sendMedia!({ ...(ctx as object), mediaUrl: payload.mediaUrl } as never) : outboundAdapter.sendText!(ctx)));
    }
    return { status: "sent" as const, results, receipt: {} };
  } catch (error) {
    return { status: "failed" as const, error: queued(error) };
  }
}

/** The queue keeps every failed final for retry and counts it as sent unless a refused connect in its
 *  cause chain proves it never left, as core's delivery queue does. */
function queued(error: unknown) {
  let proven = false;
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    proven ||= "code" in at && at.code === "ECONNREFUSED" && "syscall" in at && at.syscall === "connect";
  }
  return Object.assign(new Error(String(error), { cause: error }), { queueCustody: "held", sentBeforeError: !proven });
}

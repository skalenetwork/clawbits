import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

type RoutePeer = { kind: string; id: string };

type GuardRuntime = {
  routing?: {
    resolveAgentRoute?: (input: {
      cfg: OpenClawConfig;
      channel: string;
      accountId?: string | null;
      peer?: RoutePeer | null;
    }) => { agentId?: unknown; sessionKey?: unknown } | undefined;
  };
};

export type InboundDispatchGuardTarget = {
  sessionKey: string;
  agentId?: string;
};

const LOCKS = Symbol.for("clawbits.inboundDispatchLocks");

function locks(): Map<string, Promise<void>> {
  const host = globalThis as Record<symbol, Map<string, Promise<void>> | undefined>;
  return (host[LOCKS] ??= new Map());
}

export function resolveInboundDispatchGuardTarget(params: {
  cfg: OpenClawConfig;
  runtime: unknown;
  channel: string;
  accountId: string;
  peer: RoutePeer;
}): InboundDispatchGuardTarget | undefined {
  const route = (params.runtime as GuardRuntime | undefined)?.routing?.resolveAgentRoute?.({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
  });
  if (typeof route?.sessionKey !== "string" || !route.sessionKey) return undefined;
  return typeof route.agentId === "string"
    ? { sessionKey: route.sessionKey, agentId: route.agentId }
    : { sessionKey: route.sessionKey };
}

/** One dispatch per session at a time across both clawbits plugins in this gateway process. */
export async function withInboundDispatchGuard<T>(
  target: InboundDispatchGuardTarget | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!target?.sessionKey) return await run();
  const held = locks();
  const previous = held.get(target.sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const tail = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
  held.set(target.sessionKey, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (held.get(target.sessionKey) === tail) held.delete(target.sessionKey);
  }
}

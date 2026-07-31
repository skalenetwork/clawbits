import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_STALE_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 100;
const LOCK_DIR_NAME = ".clawbits-inbound-dispatch-locks";

type RoutePeer = { kind: string; id: string };

type GuardRoute = {
  agentId?: unknown;
  sessionKey?: unknown;
};

type GuardRuntime = {
  routing?: {
    resolveAgentRoute?: (input: {
      cfg: OpenClawConfig;
      channel: string;
      accountId?: string | null;
      peer?: RoutePeer | null;
    }) => GuardRoute | undefined;
  };
  session?: {
    resolveStorePath?: (store: string | undefined, opts: { agentId: string }) => string;
  };
};

export type InboundDispatchGuardTarget = {
  sessionKey: string;
  lockDir?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSessionStoreConfig(cfg: OpenClawConfig): string | undefined {
  const session = (cfg as { session?: unknown }).session;
  if (!session || typeof session !== "object") return undefined;
  const store = (session as { store?: unknown }).store;
  return typeof store === "string" && store.trim() ? store : undefined;
}

function lockNameForSession(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey).digest("hex");
}

function resolveDefaultLockDir(): string {
  return path.join(os.tmpdir(), LOCK_DIR_NAME);
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

function isEexist(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "EEXIST";
}

async function maybeRemoveStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let stat;
  try {
    stat = await fs.stat(lockPath);
  } catch (err) {
    if (isEnoent(err)) return true;
    return false;
  }
  if (Date.now() - stat.mtimeMs < staleMs) return false;
  await fs.rm(lockPath, { recursive: true, force: true });
  return true;
}

async function acquireSessionDispatchLock(params: {
  sessionKey: string;
  lockDir?: string;
  acquireTimeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}): Promise<() => Promise<void>> {
  const lockDir = params.lockDir ?? resolveDefaultLockDir();
  const lockPath = path.join(lockDir, lockNameForSession(params.sessionKey));
  const deadline = Date.now() + (params.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
  const staleMs = params.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = params.pollMs ?? DEFAULT_POLL_MS;

  await fs.mkdir(lockDir, { recursive: true });
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, sessionKey: params.sessionKey, createdAt: Date.now() }),
      );
      return async () => {
        await fs.rm(lockPath, { recursive: true, force: true });
      };
    } catch (err) {
      if (!isEexist(err)) throw err;
      await maybeRemoveStaleLock(lockPath, staleMs);
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for inbound dispatch lock for ${params.sessionKey}`);
      }
      await sleep(pollMs);
    }
  }
}

export function resolveInboundDispatchGuardTarget(params: {
  cfg: OpenClawConfig;
  runtime: unknown;
  channel: string;
  accountId: string;
  peer: RoutePeer;
}): InboundDispatchGuardTarget | undefined {
  const runtime = params.runtime as GuardRuntime | undefined;
  const route = runtime?.routing?.resolveAgentRoute?.({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
  });
  const sessionKey = typeof route?.sessionKey === "string" ? route.sessionKey : undefined;
  if (!sessionKey) return undefined;

  const agentId = typeof route?.agentId === "string" ? route.agentId : undefined;
  const resolveStorePath = runtime?.session?.resolveStorePath;
  if (!agentId || typeof resolveStorePath !== "function") return { sessionKey };

  try {
    const storePath = resolveStorePath(resolveSessionStoreConfig(params.cfg), { agentId });
    return { sessionKey, lockDir: path.join(path.dirname(storePath), LOCK_DIR_NAME) };
  } catch {
    return { sessionKey };
  }
}

export async function withInboundDispatchGuard<T>(
  target: InboundDispatchGuardTarget | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!target?.sessionKey) return await run();
  const release = await acquireSessionDispatchLock(target);
  try {
    return await run();
  } finally {
    await release();
  }
}

export const __test = {
  acquireSessionDispatchLock,
  lockNameForSession,
};

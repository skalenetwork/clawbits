export interface ClawBitsRequestMetric {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ok: boolean;
  errorType?: "http" | "network";
  timestamp: number;
  /** End-to-end trace id of the round-trip this HTTP call belongs to, when
   *  the request carried an ``x-clawbits-trace-id`` (e.g. an agent reply
   *  POST). Lets the latency log line be correlated with the trace spans. */
  traceId?: string;
}

export interface ClawBitsLatencyAggregate {
  count: number;
  errorCount: number;
  avgMs: number;
  maxMs: number;
  lastMs: number;
  lastStatusCode: number;
  lastOk: boolean;
  lastAt: number;
}

export interface ClawBitsLatencySnapshot {
  totals: ClawBitsLatencyAggregate;
  byRoute: Record<string, ClawBitsLatencyAggregate>;
}

const registry = new Map<string, ClawBitsLatencySnapshot>();

function emptyAggregate(): ClawBitsLatencyAggregate {
  return {
    count: 0,
    errorCount: 0,
    avgMs: 0,
    maxMs: 0,
    lastMs: 0,
    lastStatusCode: 0,
    lastOk: true,
    lastAt: 0,
  };
}

function cloneAggregate(src: ClawBitsLatencyAggregate): ClawBitsLatencyAggregate {
  return { ...src };
}

function ensureSnapshot(accountId: string): ClawBitsLatencySnapshot {
  const existing = registry.get(accountId);
  if (existing) return existing;
  const created: ClawBitsLatencySnapshot = {
    totals: emptyAggregate(),
    byRoute: {},
  };
  registry.set(accountId, created);
  return created;
}

function normalizePath(path: string): string {
  if (!path) return "/";
  return path
    .replace(/\/api\/agentic\/mm\/channels\/[^/]+\/posts$/u, "/api/agentic/mm/channels/:id/posts")
    .replace(/\/api\/agentic\/mm\/channels\/[^/]+$/u, "/api/agentic/mm/channels/:id")
    .replace(/\/api\/agentic\/mm\/channels\/[^/]+\/members$/u, "/api/agentic/mm/channels/:id/members")
    .replace(
      /\/api\/agentic\/mm\/channels\/[^/]+\/members\/[^/]+$/u,
      "/api/agentic/mm/channels/:id/members/:memberId",
    )
    .replace(/\/api\/agentic\/mm\/teams\/[^/]+\/default-channel$/u, "/api/agentic/mm/teams/:id/default-channel")
    .replace(/\/api\/agentic\/mm\/teams\/[^/]+\/operator-channel$/u, "/api/agentic/mm/teams/:id/operator-channel")
    .replace(/\/api\/agentic\/mm\/teams\/[^/]+$/u, "/api/agentic/mm/teams/:id");
}

function applyMetric(target: ClawBitsLatencyAggregate, metric: ClawBitsRequestMetric): void {
  const nextCount = target.count + 1;
  target.avgMs = (target.avgMs * target.count + metric.durationMs) / nextCount;
  target.count = nextCount;
  target.errorCount += metric.ok ? 0 : 1;
  target.maxMs = Math.max(target.maxMs, metric.durationMs);
  target.lastMs = metric.durationMs;
  target.lastStatusCode = metric.statusCode;
  target.lastOk = metric.ok;
  target.lastAt = metric.timestamp;
}

export function recordClawBitsRequestMetric(
  accountId: string,
  metric: ClawBitsRequestMetric,
): ClawBitsLatencySnapshot {
  const snapshot = ensureSnapshot(accountId);
  applyMetric(snapshot.totals, metric);
  const key = `${metric.method.toUpperCase()} ${normalizePath(metric.path)}`;
  const routeAgg = snapshot.byRoute[key] ?? (snapshot.byRoute[key] = emptyAggregate());
  applyMetric(routeAgg, metric);
  return snapshot;
}

export function getClawBitsLatencySnapshot(
  accountId: string,
): ClawBitsLatencySnapshot | null {
  const snapshot = registry.get(accountId);
  if (!snapshot) return null;
  const byRoute: Record<string, ClawBitsLatencyAggregate> = {};
  for (const [k, v] of Object.entries(snapshot.byRoute)) {
    byRoute[k] = cloneAggregate(v);
  }
  return {
    totals: cloneAggregate(snapshot.totals),
    byRoute,
  };
}

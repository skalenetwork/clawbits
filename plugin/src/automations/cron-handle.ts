// In-process handle to OpenClaw's cron service + Clawbits-spec mapping.
//
// The plugin manages cron through `ctx.getCron()`, captured in the
// `gateway_start` hook (see index.ts). That handle IS the gateway's real
// CronService — operator scopes / device pairing gate only EXTERNAL clients, so
// the in-process plugin needs no token, pairing, or write scope, and this works
// identically on BYO self-hosted and Reef. The SDK's public type for getCron is
// narrower than the runtime object, so we self-type the surface we use here
// (validated against packages/gateway-protocol/src/schema/cron.ts at 2026.6.10).
// See docs/protocol/OPENCLAW_AUTOMATIONS_INTEGRATION_STRATEGY.md §1 item 0 / §7.1.

// ---------------------------------------------------------------------------
// Self-typed cron surface (the real runtime CronService, fuller than the
// public PluginHookGatewayCronService type).
// ---------------------------------------------------------------------------

export type CronSchedule =
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | { kind: "at"; at: number };

export type CronPayload =
  | { kind: "agentTurn"; message: string; model?: string; [k: string]: unknown }
  | { kind: "command"; argv: string[]; [k: string]: unknown }
  | { kind: "systemEvent"; text?: string; [k: string]: unknown };

/** Delivery policy for a cron job's output (OpenClaw `CronDeliverySchema`).
 *  We only use `announce` (route output to a channel); the runtime also accepts
 *  `none`/`webhook`. For a Clawbits automation, `channel` is the "clawbits"
 *  channel-plugin id and `to` is the owner channel UUID (see reconcile.ts). */
export interface CronDelivery {
  mode: "announce" | "none" | "webhook";
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  bestEffort?: boolean;
  [k: string]: unknown;
}

export interface CronAddParams {
  name: string;
  description?: string;
  schedule: CronSchedule;
  sessionTarget: string;
  wakeMode: string;
  payload: CronPayload;
  delivery?: CronDelivery;
  enabled?: boolean;
  /** Native failure alerting (OpenClaw `CronFailureAlertSchema`, or `false`
   *  to disable). Authored operator-side as `{after: N}`; routing fields fall
   *  back to the runtime defaults. */
  failureAlert?: unknown;
  /** One-shot jobs (`schedule.kind === "at"`): disarm after the run. */
  deleteAfterRun?: boolean;
}

export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: string;
  lastError?: string;
  consecutiveErrors?: number;
  lastDurationMs?: number;
  runningAtMs?: number;
  // Delivery outcome of the last run, tracked by the gateway SEPARATELY from
  // the turn status: a run can complete (`lastRunStatus:"ok"`) yet fail to
  // reach its channel (`lastDelivered:false` / `lastDeliveryStatus:
  // "not-delivered"`). Reporting only lastRunStatus is why "ran, no error" used
  // to hide a dropped announce. (OpenClaw `CronJobStateSchema`, 2026.6.10.)
  lastDelivered?: boolean;
  lastDeliveryStatus?: "delivered" | "not-delivered" | "unknown" | "not-requested" | string;
  lastDeliveryError?: string;
  [k: string]: unknown;
}

export interface CronJobView {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: unknown;
  sessionTarget?: string;
  wakeMode?: string;
  payload?: unknown;
  state?: CronJobState;
  [k: string]: unknown;
}

export interface CronHandle {
  list(opts?: { includeDisabled?: boolean }): Promise<CronJobView[]>;
  add(input: CronAddParams): Promise<unknown>;
  update(id: string, patch: Partial<CronAddParams>): Promise<unknown>;
  remove(id: string): Promise<{ removed?: boolean }>;
  // Run a job immediately (mode "force") or only if due ("due"). On the real
  // runtime CronService (`src/cron/service.ts`); not in the narrow public type.
  // Returns the gateway's run outcome — inspect it (a forced run can still
  // decline: paused job, already running, invalid spec) rather than assume it
  // fired.
  run(id: string, mode?: "due" | "force"): Promise<CronRunResult>;
}

// ---------------------------------------------------------------------------
// Run result. A forced run is not guaranteed to execute: OpenClaw's
// `CronRunResult` (src/cron/service/state.ts, 2026.6.10) is a discriminated
// union — it either ran inline, was enqueued to run, or declined with a reason.
// The reconciler used to discard this, so a manual run that never started
// silently consumed the request. We interpret it and surface non-runs honestly.
// ---------------------------------------------------------------------------

export type CronRunResult =
  | { ok: true; ran: true }
  | { ok: true; enqueued: true; runId?: string }
  | { ok: true; ran: false; reason: string }
  | { ok: false }
  | Record<string, unknown>;

export interface RunOutcome {
  /** The run started — executed inline or was enqueued to run on the scheduler.
   *  Its real result (incl. delivery) then surfaces via the next state report. */
  started: boolean;
  /** For a run that did NOT start: `skipped` = benign/transient (retry helps),
   *  `error` = actionable (paused, invalid). `started` when it did run. */
  kind: "started" | "skipped" | "error";
  /** Machine reason the gateway gave for declining, when it did. */
  reason?: string;
}

const TRANSIENT_RUN_REASONS = new Set([
  "already-running",
  "restart-recovery-pending",
  "not-due",
]);

/** Map a (defensively-typed) cron run result to an honest outcome. Unknown
 *  shapes are treated as "started" so we never invent a failure the operator
 *  can't act on — the authoritative result arrives with the next state report. */
export function interpretRunResult(result: unknown): RunOutcome {
  const r = (result ?? {}) as Record<string, unknown>;
  if (r.ran === true || r.enqueued === true) return { started: true, kind: "started" };
  if (r.ok === false) return { started: false, kind: "error", reason: "rejected" };
  if (r.ran === false) {
    const reason = typeof r.reason === "string" ? r.reason : "declined";
    return {
      started: false,
      kind: TRANSIENT_RUN_REASONS.has(reason) ? "skipped" : "error",
      reason,
    };
  }
  return { started: true, kind: "started" };
}

// ---------------------------------------------------------------------------
// Process-global handle holder. One gateway = one cron service, shared by every
// account on this machine; set once from the gateway_start hook.
// ---------------------------------------------------------------------------

let cronHandle: CronHandle | undefined;

export function setCronHandle(handle: CronHandle | undefined): void {
  cronHandle = handle;
}

export function getCronHandle(): CronHandle | undefined {
  return cronHandle;
}

// ---------------------------------------------------------------------------
// Clawbits ↔ cron job correlation. CronJob has no general metadata field, so a
// managed job carries a stable sentinel in its description; we match on that
// (plus the reported gateway_job_id) rather than on name alone.
// ---------------------------------------------------------------------------

const SENTINEL_PREFIX = "clawbits-id=";
const SENTINEL_RE = /clawbits-id=([A-Za-z0-9]+)/;

export function clawbitsSentinel(automationId: string): string {
  return `${SENTINEL_PREFIX}${automationId}`;
}

/** The Clawbits automation id a cron job is managed by, or undefined. */
export function parseSentinel(job: CronJobView): string | undefined {
  const haystack = `${job.description ?? ""} ${job.name ?? ""}`;
  return SENTINEL_RE.exec(haystack)?.[1];
}

/** Normalize a Clawbits desired_spec into cron.add params + embed the sentinel.
 *  The desired_spec is already a normalized OpenClaw cron payload (the backend
 *  validated it on create), so this is mostly pass-through with light guards.
 *
 *  Delivery: a scheduled job runs in an isolated session with no "last" channel,
 *  so without an explicit route OpenClaw refuses the announce and the output is
 *  dropped ("no route, will fail-closed"). The owner channel UUID is a
 *  runtime-only value the backend can't author (it stores no channel identity
 *  for an agent), so the caller passes `defaultDelivery` and we apply it unless
 *  the spec already carries an explicit `delivery` override. */
export function specToCronAdd(
  spec: Record<string, unknown>,
  automationId: string,
  opts?: { defaultDelivery?: CronDelivery },
): CronAddParams {
  const sentinel = clawbitsSentinel(automationId);
  const userDesc =
    typeof spec.description === "string" && spec.description.trim()
      ? ` · ${spec.description.trim()}`
      : "";
  const specDelivery =
    spec.delivery && typeof spec.delivery === "object"
      ? (spec.delivery as Partial<CronDelivery>)
      : undefined;
  // The operator authors only the target (`to` = a chosen channel id); the
  // runtime-owned fields (`channel`="clawbits", `accountId`) come from
  // `defaultDelivery` (the owner-DM envelope built per-account). Merge so the
  // operator's `to`/`mode` win while channel/accountId fill in — a plain swap
  // would drop those and the announce would fail to route. With no operator
  // delivery, the owner-DM default applies unchanged.
  const delivery: CronDelivery | undefined =
    specDelivery && opts?.defaultDelivery
      ? { ...opts.defaultDelivery, ...specDelivery }
      : ((specDelivery as CronDelivery | undefined) ?? opts?.defaultDelivery);
  return {
    name: typeof spec.name === "string" && spec.name.trim() ? spec.name : "Automation",
    description: `${sentinel}${userDesc}`,
    schedule: spec.schedule as CronSchedule,
    sessionTarget:
      typeof spec.sessionTarget === "string" ? spec.sessionTarget : "isolated",
    wakeMode: typeof spec.wakeMode === "string" ? spec.wakeMode : "next-heartbeat",
    payload: spec.payload as CronPayload,
    ...(delivery ? { delivery } : {}),
    enabled: typeof spec.enabled === "boolean" ? spec.enabled : true,
    // Pass-through of the optional cron.add fields the backend allowlists
    // (spec.py). ALWAYS emitted (with the schema's explicit "off" values, not
    // omitted): reconcile updates via cron.update(id, patch) with Partial
    // semantics, so omitting a key would leave a previously-set alert/one-shot
    // flag stuck on the job after the operator removes it from the spec.
    // If a value doesn't validate against the runtime schema the add/update
    // rejects and the failure surfaces as sync_status="failed".
    failureAlert: spec.failureAlert !== undefined ? spec.failureAlert : false,
    deleteAfterRun: spec.deleteAfterRun === true,
  };
}

// ---------------------------------------------------------------------------
// Drift detection. Re-applying an identical spec via cron.update every
// reconcile cycle is NOT harmless: the gateway treats any patch that carries
// `schedule`/`enabled` as a schedule change and recomputes state.nextRunAtMs
// from `now` — and a patched `kind:"every"` schedule REPLACES the stored one,
// wiping its persisted anchorMs, which the gateway then re-anchors at `now`
// (verified against OpenClaw 2026.6.10 `update()`/`applyJobPatch`). With the
// 60s reconcile loop that pushed every job's next run perpetually ~everyMs
// into the future: an "every N hours" automation never fired while dutifully
// reporting applied/synced. So reconcile must be convergent — compare first,
// write only on real drift.
// ---------------------------------------------------------------------------

function normStr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** Every field the desired object sets matches the actual one. Extra
 *  runtime-filled fields on the actual side are ignored — cron.update MERGES
 *  payload/delivery/failureAlert rather than replacing, so a key absent from
 *  the desired side is not removable by an update anyway. */
function subsetMatches(desired: Record<string, unknown>, actual: unknown): boolean {
  if (!actual || typeof actual !== "object") return false;
  const a = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    if (!deepEqual(a[key], value)) return false;
  }
  return true;
}

function scheduleMatches(desired: CronSchedule, actual: unknown): boolean {
  if (!actual || typeof actual !== "object") return false;
  const a = actual as Record<string, unknown>;
  if (a.kind !== desired.kind) return false;
  switch (desired.kind) {
    case "every":
      if (a.everyMs !== desired.everyMs) return false;
      // anchorMs is runtime-assigned unless authored — ignore the job's own.
      return desired.anchorMs === undefined || a.anchorMs === desired.anchorMs;
    case "cron":
      if (normStr(a.expr) !== normStr(desired.expr)) return false;
      if (normStr(a.tz) !== normStr(desired.tz)) return false;
      // staggerMs is runtime-defaulted unless authored — ignore the job's own.
      return desired.staggerMs === undefined || a.staggerMs === desired.staggerMs;
    case "at": {
      const dn = typeof desired.at === "number" ? desired.at : Number(desired.at);
      const an = typeof a.at === "number" ? a.at : Number(a.at);
      return Number.isFinite(dn) && Number.isFinite(an)
        ? dn === an
        : deepEqual(a.at, desired.at);
    }
  }
}

const failureAlertOff = (value: unknown): boolean => value === undefined || value === false;

/** True when applying `params` to `job` would be a no-op, i.e. the local job
 *  already reflects the desired spec on every field the reconciler manages. */
export function cronJobMatchesParams(job: CronJobView, params: CronAddParams): boolean {
  if (normStr(job.name) !== normStr(params.name)) return false;
  if (normStr(job.description) !== normStr(params.description)) return false;
  if (!scheduleMatches(params.schedule, job.schedule)) return false;
  if (job.sessionTarget !== params.sessionTarget) return false;
  if (job.wakeMode !== params.wakeMode) return false;
  if ((job.enabled ?? true) !== (params.enabled ?? true)) return false;
  if (!subsetMatches(params.payload as unknown as Record<string, unknown>, job.payload)) {
    return false;
  }
  // No desired delivery (owner channel unresolved this pass) → leave whatever
  // route the job has; never treat it as drift to clear.
  if (params.delivery && !subsetMatches(params.delivery, job.delivery)) return false;
  const actualAlert = job.failureAlert;
  if (failureAlertOff(params.failureAlert)) {
    if (!failureAlertOff(actualAlert)) return false;
  } else if (params.failureAlert && typeof params.failureAlert === "object") {
    if (!subsetMatches(params.failureAlert as Record<string, unknown>, actualAlert)) {
      return false;
    }
  } else if (!deepEqual(actualAlert, params.failureAlert)) return false;
  const actualDelete = job.deleteAfterRun === true;
  if ((params.deleteAfterRun ?? false) !== actualDelete) return false;
  return true;
}

/** When a REAL update is applied to an `every` job whose interval is
 *  unchanged, carry the job's existing anchorMs into the patch: the gateway
 *  replaces the schedule wholesale and would otherwise re-anchor the interval
 *  grid at `now`, resetting the job's cadence on every unrelated edit (e.g. a
 *  prompt tweak). A changed everyMs keeps the natural "re-anchor from now". */
export function preserveEveryAnchor(params: CronAddParams, job: CronJobView): CronAddParams {
  if (params.schedule.kind !== "every" || params.schedule.anchorMs !== undefined) {
    return params;
  }
  const current = job.schedule;
  if (!current || typeof current !== "object") return params;
  const c = current as Record<string, unknown>;
  if (c.kind !== "every" || c.everyMs !== params.schedule.everyMs) return params;
  if (typeof c.anchorMs !== "number" || !Number.isFinite(c.anchorMs)) return params;
  return { ...params, schedule: { ...params.schedule, anchorMs: c.anchorMs } };
}

/** Best-effort extraction of a job id from a cron.add result (shape varies). */
export function extractJobId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  for (const key of ["id", "jobId", "job_id"]) {
    if (typeof r[key] === "string") return r[key] as string;
  }
  const job = r.job;
  if (job && typeof job === "object" && typeof (job as Record<string, unknown>).id === "string") {
    return (job as Record<string, unknown>).id as string;
  }
  return undefined;
}

// Convergence tests for the automations reconciler. The prod incident these
// guard against: the reconciler used to re-apply cron.update on EVERY 60s
// cycle; the gateway recomputes nextRunAtMs from `now` for any patch carrying
// schedule/enabled and re-anchors `kind:"every"` intervals at `now`, so an
// "every N hours" automation reported synced forever but never fired. The
// reconcile must be convergent: an in-sync job gets NO write.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ClawBitsClient } from "../src/client.js";
import {
  type CronAddParams,
  type CronHandle,
  type CronJobView,
  type CronRunResult,
  clawbitsSentinel,
  cronJobMatchesParams,
  interpretRunResult,
  preserveEveryAnchor,
  specToCronAdd,
} from "../src/automations/cron-handle.js";
import { ownerChannelDelivery, reconcileOnce } from "../src/automations/reconcile.js";

const OWNER_CHANNEL = "916abcc5-5eb2-4bb9-9ff6-b3b5b7070b4d";

const everySpec = {
  name: "Hourly digest",
  schedule: { kind: "every", everyMs: 3_600_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "Post a digest." },
  enabled: true,
};

/** The job view the gateway would hold after applying `params`: same fields,
 *  plus the runtime-owned additions (id, an anchored `every` schedule, state). */
function appliedJobView(params: CronAddParams, id = "cron_1"): CronJobView {
  const schedule =
    params.schedule.kind === "every"
      ? { ...params.schedule, anchorMs: params.schedule.anchorMs ?? 1_000_000 }
      : { ...params.schedule };
  return {
    id,
    name: params.name,
    description: params.description,
    schedule,
    sessionTarget: params.sessionTarget,
    wakeMode: params.wakeMode,
    payload: structuredClone(params.payload),
    ...(params.delivery ? { delivery: structuredClone(params.delivery) } : {}),
    enabled: params.enabled ?? true,
    state: { nextRunAtMs: 4_600_000 },
  };
}

interface FakeCron extends CronHandle {
  calls: { method: string; args: unknown[] }[];
}

function fakeCron(
  jobs: CronJobView[],
  runResult: CronRunResult = { ok: true, ran: true },
): FakeCron {
  const calls: FakeCron["calls"] = [];
  return {
    calls,
    list: async () => {
      calls.push({ method: "list", args: [] });
      return jobs;
    },
    add: async (input) => {
      calls.push({ method: "add", args: [input] });
      return { id: "cron_new" };
    },
    update: async (id, patch) => {
      calls.push({ method: "update", args: [id, patch] });
      return {};
    },
    remove: async (id) => {
      calls.push({ method: "remove", args: [id] });
      return { removed: true };
    },
    run: async (id, mode) => {
      calls.push({ method: "run", args: [id, mode] });
      return runResult;
    },
  };
}

function fakeClient(desired: unknown): ClawBitsClient & { statePosts: unknown[] } {
  const statePosts: unknown[] = [];
  const client = {
    statePosts,
    hasApiKey: () => true,
    request: async (method: string, path: string, opts?: { json?: unknown }) => {
      if (method === "GET" && path.includes("desired")) return desired;
      if (method === "POST" && path.includes("state")) {
        statePosts.push(opts?.json);
        return {};
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
  return client as unknown as ClawBitsClient & { statePosts: unknown[] };
}

function desiredResponse(spec: Record<string, unknown>, overrides?: Record<string, unknown>) {
  return {
    schema_version: "1",
    desired_generation: 3,
    automations: [
      {
        automation_id: "auto1",
        gateway_job_id: "cron_1",
        desired_generation: 3,
        intent: "present",
        desired_spec: spec,
        spec_hash: "h",
        ...overrides,
      },
    ],
  };
}

describe("reconcileOnce convergence", () => {
  it("does NOT cron.update a job that already matches the desired spec", async () => {
    const defaultDelivery = ownerChannelDelivery({
      accountId: "default",
      channelId: OWNER_CHANNEL,
    });
    const params = specToCronAdd(everySpec, "auto1", { defaultDelivery });
    const cron = fakeCron([appliedJobView(params)]);
    const client = fakeClient(desiredResponse(everySpec));

    await reconcileOnce({ cron, client, accountId: "default", ownerChannelId: OWNER_CHANNEL });

    const writes = cron.calls.filter((c) => c.method !== "list");
    assert.deepEqual(writes, [], "an in-sync job must get no cron write");
    // The pass still self-reports applied.
    const report = client.statePosts[0] as { managed: { status: string }[] };
    assert.equal(report.managed[0].status, "applied");
  });

  it("converges a drifted job and preserves the every-interval anchor", async () => {
    const defaultDelivery = ownerChannelDelivery({
      accountId: "default",
      channelId: OWNER_CHANNEL,
    });
    const params = specToCronAdd(everySpec, "auto1", { defaultDelivery });
    const job = appliedJobView(params);
    // Local drift: the payload prompt was edited outside Clawbits.
    (job.payload as { message: string }).message = "tampered";
    const cron = fakeCron([job]);
    const client = fakeClient(desiredResponse(everySpec));

    await reconcileOnce({ cron, client, accountId: "default", ownerChannelId: OWNER_CHANNEL });

    const updates = cron.calls.filter((c) => c.method === "update");
    assert.equal(updates.length, 1, "a drifted job must be converged");
    const patch = updates[0].args[1] as CronAddParams;
    assert.equal(
      (patch.schedule as { anchorMs?: number }).anchorMs,
      1_000_000,
      "the update must carry the job's existing anchor, not re-anchor at now",
    );
  });

  it("creates the job when it is missing", async () => {
    const cron = fakeCron([]);
    const client = fakeClient(desiredResponse(everySpec));
    await reconcileOnce({ cron, client, accountId: "default" });
    assert.equal(cron.calls.filter((c) => c.method === "add").length, 1);
  });

  it("still honors run-now on an in-sync job (run without update)", async () => {
    const params = specToCronAdd(everySpec, "auto1");
    const cron = fakeCron([appliedJobView(params)]);
    const client = fakeClient(
      desiredResponse(everySpec, {
        run_requested_generation: 2,
        run_observed_generation: 1,
      }),
    );

    await reconcileOnce({ cron, client, accountId: "default" });

    assert.deepEqual(
      cron.calls.filter((c) => c.method !== "list").map((c) => c.method),
      ["run"],
      "run-now must fire without a spec rewrite",
    );
    const report = client.statePosts[0] as {
      managed: { run_observed_generation?: number }[];
    };
    assert.equal(report.managed[0].run_observed_generation, 2);
  });

  it("surfaces a declined manual run as an honest run row (does not swallow it)", async () => {
    const params = specToCronAdd(everySpec, "auto1");
    const cron = fakeCron([appliedJobView(params)], {
      ok: true,
      ran: false,
      reason: "stopped",
    });
    const client = fakeClient(
      desiredResponse(everySpec, {
        run_requested_generation: 5,
        run_observed_generation: 4,
      }),
    );

    await reconcileOnce({ cron, client, accountId: "default" });

    // Attempted exactly once; run_observed still advances so a permanent
    // decline can't re-run every cycle.
    assert.equal(cron.calls.filter((c) => c.method === "run").length, 1);
    const report = client.statePosts[0] as {
      managed: { run_observed_generation?: number }[];
      runs: { status?: string; summary?: Record<string, unknown> }[];
    };
    assert.equal(report.managed[0].run_observed_generation, 5);
    // ...and the operator sees WHY nothing happened, as a run row.
    const miss = report.runs.find((r) => r.summary?.did_not_run === true);
    assert.ok(miss, "a declined run must be reported as a run row");
    assert.equal(miss?.status, "error");
    assert.match(String(miss?.summary?.error ?? ""), /paused/i);
  });

  it("reports an already-running manual run as skipped, not an error", async () => {
    const params = specToCronAdd(everySpec, "auto1");
    const cron = fakeCron([appliedJobView(params)], {
      ok: true,
      ran: false,
      reason: "already-running",
    });
    const client = fakeClient(
      desiredResponse(everySpec, {
        run_requested_generation: 2,
        run_observed_generation: 1,
      }),
    );

    await reconcileOnce({ cron, client, accountId: "default" });

    const report = client.statePosts[0] as {
      runs: { status?: string; summary?: Record<string, unknown> }[];
    };
    const miss = report.runs.find((r) => r.summary?.did_not_run === true);
    assert.equal(miss?.status, "skipped");
  });
});

describe("interpretRunResult", () => {
  it("treats ran and enqueued as started", () => {
    assert.equal(interpretRunResult({ ok: true, ran: true }).started, true);
    assert.equal(
      interpretRunResult({ ok: true, enqueued: true, runId: "r1" }).started,
      true,
    );
  });

  it("classifies transient declines as skipped", () => {
    for (const reason of ["already-running", "restart-recovery-pending", "not-due"]) {
      const o = interpretRunResult({ ok: true, ran: false, reason });
      assert.equal(o.started, false, `${reason} should not be started`);
      assert.equal(o.kind, "skipped", `${reason} should be skipped`);
    }
  });

  it("classifies actionable declines and rejections as error", () => {
    assert.equal(interpretRunResult({ ok: true, ran: false, reason: "stopped" }).kind, "error");
    assert.equal(
      interpretRunResult({ ok: true, ran: false, reason: "invalid-spec" }).kind,
      "error",
    );
    assert.equal(interpretRunResult({ ok: false }).kind, "error");
  });

  it("assumes started for an unknown shape (no invented failure)", () => {
    assert.equal(interpretRunResult(undefined).started, true);
    assert.equal(interpretRunResult({}).started, true);
  });
});

describe("cronJobMatchesParams", () => {
  const cronSpec = {
    ...everySpec,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/London" },
  };

  it("matches when the job mirrors the params (every kind, runtime anchor)", () => {
    const params = specToCronAdd(everySpec, "auto1");
    assert.equal(cronJobMatchesParams(appliedJobView(params), params), true);
  });

  it("ignores runtime-filled staggerMs on cron schedules", () => {
    const params = specToCronAdd(cronSpec, "auto1");
    const job = appliedJobView(params);
    (job.schedule as { staggerMs?: number }).staggerMs = 30_000;
    assert.equal(cronJobMatchesParams(job, params), true);
  });

  it("detects schedule drift (tz change)", () => {
    const params = specToCronAdd(cronSpec, "auto1");
    const job = appliedJobView(params);
    (job.schedule as { tz?: string }).tz = "UTC";
    assert.equal(cronJobMatchesParams(job, params), false);
  });

  it("detects an enabled flip (job disabled locally, desired enabled)", () => {
    const params = specToCronAdd(everySpec, "auto1");
    const job = { ...appliedJobView(params), enabled: false };
    assert.equal(cronJobMatchesParams(job, params), false);
  });

  it("treats failureAlert false and undefined as equally off", () => {
    // specToCronAdd always emits failureAlert:false when the spec has none;
    // the gateway may store it as false or leave it undefined.
    const params = specToCronAdd(everySpec, "auto1");
    assert.equal(params.failureAlert, false);
    const job = appliedJobView(params);
    delete (job as Record<string, unknown>).failureAlert;
    assert.equal(cronJobMatchesParams(job, params), true);
  });

  it("ignores extra runtime fields on the job's delivery envelope", () => {
    const params = specToCronAdd(everySpec, "auto1", {
      defaultDelivery: ownerChannelDelivery({
        accountId: "default",
        channelId: OWNER_CHANNEL,
      }),
    });
    const job = appliedJobView(params);
    (job.delivery as Record<string, unknown>).bestEffort = true;
    assert.equal(cronJobMatchesParams(job, params), true);
  });

  it("detects a delivery target change", () => {
    const params = specToCronAdd(everySpec, "auto1", {
      defaultDelivery: ownerChannelDelivery({
        accountId: "default",
        channelId: OWNER_CHANNEL,
      }),
    });
    const job = appliedJobView(params);
    (job.delivery as { to?: string }).to = "0fa1b2c3-d4e5-6789-abcd-ef0123456789";
    assert.equal(cronJobMatchesParams(job, params), false);
  });
});

describe("preserveEveryAnchor", () => {
  it("carries the job anchor when the interval is unchanged", () => {
    const params = specToCronAdd(everySpec, "auto1");
    const job = appliedJobView(params);
    const out = preserveEveryAnchor(params, job);
    assert.equal((out.schedule as { anchorMs?: number }).anchorMs, 1_000_000);
  });

  it("re-anchors (no carry) when everyMs changed", () => {
    const params = specToCronAdd(
      { ...everySpec, schedule: { kind: "every", everyMs: 7_200_000 } },
      "auto1",
    );
    const job = appliedJobView(specToCronAdd(everySpec, "auto1"));
    const out = preserveEveryAnchor(params, job);
    assert.equal((out.schedule as { anchorMs?: number }).anchorMs, undefined);
  });

  it("leaves non-every schedules untouched", () => {
    const params = specToCronAdd(
      { ...everySpec, schedule: { kind: "cron", expr: "0 9 * * *" } },
      "auto1",
    );
    const job = appliedJobView(specToCronAdd(everySpec, "auto1"));
    assert.equal(preserveEveryAnchor(params, job), params);
  });

  it("sentinel helper matches what specToCronAdd embeds", () => {
    const params = specToCronAdd(everySpec, "auto1");
    assert.ok(params.description?.startsWith(clawbitsSentinel("auto1")));
  });
});

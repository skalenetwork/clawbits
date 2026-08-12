import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { specToCronAdd, type CronDelivery } from "../src/automations/cron-handle.js";
import {
  lastRunReport,
  ownerChannelDelivery,
  reportedSpecOf,
} from "../src/automations/reconcile.js";

// A Mattermost channel id is an RFC-4122 v4 UUID; the owner channel uses one.
const OWNER_CHANNEL = "916abcc5-5eb2-4bb9-9ff6-b3b5b7070b4d";

const baseSpec = {
  name: "Daily digest",
  schedule: { kind: "every", everyMs: 86_400_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "Post a digest." },
  enabled: true,
};

describe("ownerChannelDelivery", () => {
  it("builds an announce route to the owner channel for a valid UUID", () => {
    const d = ownerChannelDelivery({ accountId: "default", channelId: OWNER_CHANNEL });
    assert.deepEqual(d, {
      mode: "announce",
      channel: "clawbits",
      to: OWNER_CHANNEL,
      accountId: "default",
    });
  });

  it("returns undefined when the owner channel id is missing", () => {
    assert.equal(ownerChannelDelivery({ accountId: "default" }), undefined);
    assert.equal(ownerChannelDelivery({ accountId: "default", channelId: "" }), undefined);
    assert.equal(
      ownerChannelDelivery({ accountId: "default", channelId: "   " }),
      undefined,
    );
  });

  it("returns undefined for a non-UUID channel id (no bogus route)", () => {
    assert.equal(
      ownerChannelDelivery({ accountId: "default", channelId: "not-a-uuid" }),
      undefined,
    );
    // The `default` sentinel is not a concrete UUID and must not be used as `to`.
    assert.equal(
      ownerChannelDelivery({ accountId: "default", channelId: "default" }),
      undefined,
    );
  });
});

describe("specToCronAdd delivery", () => {
  it("injects the default delivery when the spec has none", () => {
    const defaultDelivery = ownerChannelDelivery({
      accountId: "default",
      channelId: OWNER_CHANNEL,
    });
    const params = specToCronAdd(baseSpec, "auto-1", { defaultDelivery });
    assert.deepEqual(params.delivery, {
      mode: "announce",
      channel: "clawbits",
      to: OWNER_CHANNEL,
      accountId: "default",
    });
  });

  it("omits delivery when there is no default and the spec has none", () => {
    const params = specToCronAdd(baseSpec, "auto-1");
    assert.equal("delivery" in params, false);
  });

  it("merges an operator's chosen channel into the runtime envelope", () => {
    // The operator authors only `to` (a chosen channel id); the plugin fills
    // channel + accountId from the owner-DM default envelope.
    const CHOSEN = "0fa1b2c3-d4e5-6789-abcd-ef0123456789";
    const defaultDelivery = ownerChannelDelivery({
      accountId: "default",
      channelId: OWNER_CHANNEL,
    });
    const params = specToCronAdd(
      { ...baseSpec, delivery: { mode: "announce", to: CHOSEN } },
      "auto-1",
      { defaultDelivery },
    );
    assert.deepEqual(params.delivery, {
      mode: "announce",
      channel: "clawbits",
      to: CHOSEN, // operator's target wins
      accountId: "default", // runtime field filled from the default envelope
    });
  });

  it("falls back to the bare spec delivery when no default envelope exists", () => {
    const partial: CronDelivery = { mode: "announce", to: "abc" };
    const params = specToCronAdd({ ...baseSpec, delivery: partial }, "auto-1");
    assert.deepEqual(params.delivery, partial);
  });

  it("still embeds the correlation sentinel in the description", () => {
    const params = specToCronAdd(baseSpec, "auto-xyz");
    assert.match(params.description ?? "", /clawbits-id=auto-xyz/);
  });
});

describe("lastRunReport", () => {
  it("derives a run from a job's last-run state", () => {
    const run = lastRunReport("auto-1", {
      id: "cron_1",
      state: {
        lastRunAtMs: 1000,
        lastRunStatus: "error",
        lastDurationMs: 250,
        lastError: "boom",
      },
    });
    assert.deepEqual(run, {
      automation_id: "auto-1",
      gateway_job_id: "cron_1",
      gateway_run_id: "run:1000",
      status: "error",
      started_at_ms: 1000,
      finished_at_ms: 1250,
      summary: { error: "boom" },
    });
  });

  it("returns undefined when the job has not run yet", () => {
    assert.equal(lastRunReport("auto-1", { id: "cron_1" }), undefined);
    assert.equal(lastRunReport("auto-1", { id: "cron_1", state: {} }), undefined);
  });

  it("carries delivery outcome ALONGSIDE an ok turn (the silent-drop case)", () => {
    // The agent turn succeeded, but the announce never reached the channel.
    const run = lastRunReport("auto-1", {
      id: "cron_1",
      state: {
        lastRunAtMs: 2000,
        lastRunStatus: "ok",
        lastDurationMs: 100,
        lastDelivered: false,
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: "channel not found",
      },
    });
    // The turn status stays honest (it ran), and the delivery failure rides in
    // the summary so the operator sees a distinct "not delivered" state.
    assert.equal(run?.status, "ok");
    assert.deepEqual(run?.summary, {
      delivered: false,
      delivery_status: "not-delivered",
      delivery_error: "channel not found",
    });
  });

  it("marks a delivered run as delivered:true", () => {
    const run = lastRunReport("auto-1", {
      id: "cron_1",
      state: { lastRunAtMs: 3000, lastRunStatus: "ok", lastDelivered: true },
    });
    assert.equal((run?.summary as { delivered?: boolean }).delivered, true);
  });
});

describe("reportedSpecOf", () => {
  it("mirrors an external job's delivery route, not just its identity", () => {
    // The mirror is the ONLY spec an external job has in Clawbits — anything
    // dropped here shows up as a blank "Managed outside Clawbits" forever.
    const spec = reportedSpecOf({
      id: "cron_ext",
      name: "agentpit-reference",
      schedule: { kind: "every", everyMs: 900_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run the agentpit-reference skill" },
      enabled: true,
      delivery: { mode: "announce", channel: "clawbits", to: OWNER_CHANNEL },
      failureAlert: { after: 3 },
      deleteAfterRun: false,
    });
    assert.deepEqual(spec.delivery, {
      mode: "announce",
      channel: "clawbits",
      to: OWNER_CHANNEL,
    });
    assert.deepEqual(spec.failureAlert, { after: 3 });
    assert.equal(spec.deleteAfterRun, false);
    assert.equal(spec.name, "agentpit-reference");
  });

  it("keeps runtime-owned fields out of the mirrored spec", () => {
    // `state` rides in its own report field; id/timestamps are not spec.
    const spec = reportedSpecOf({
      id: "cron_ext",
      name: "job",
      createdAtMs: 1,
      updatedAtMs: 2,
      state: { lastRunAtMs: 3, consecutiveErrors: 78 },
    });
    assert.equal("id" in spec, false);
    assert.equal("state" in spec, false);
    assert.equal("createdAtMs" in spec, false);
    assert.equal("updatedAtMs" in spec, false);
  });
});

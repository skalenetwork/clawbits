import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLAWBITS_CHANNEL_ID_RE,
  looksLikeClawBitsId,
  messagingAdapter,
  normalizeClawBitsTarget,
} from "../src/plugin.js";

const REAL_UUID = "916abcc5-5eb2-4bb9-9ff6-b3b5b7070b4d";

describe("looksLikeClawBitsId", () => {
  it("accepts UUID-shaped channel ids", () => {
    assert.equal(looksLikeClawBitsId(REAL_UUID), true);
    assert.equal(CLAWBITS_CHANNEL_ID_RE.test(REAL_UUID), true);
  });

  it("accepts the `default` sentinel (any case)", () => {
    assert.equal(looksLikeClawBitsId("default"), true);
    assert.equal(looksLikeClawBitsId("DEFAULT"), true);
  });

  it("rejects empty, peer-shaped, or arbitrary identifiers", () => {
    assert.equal(looksLikeClawBitsId(""), false);
    // peer addresses (the failure shape from session deliveryContext)
    assert.equal(looksLikeClawBitsId("human:3"), false);
    assert.equal(looksLikeClawBitsId("clawbits:human:3", "human:3"), false);
    // arbitrary non-UUID
    assert.equal(looksLikeClawBitsId("ch-explicit"), false);
  });
});

describe("normalizeClawBitsTarget", () => {
  it("strips the optional clawbits: prefix", () => {
    assert.equal(normalizeClawBitsTarget(`clawbits:${REAL_UUID}`), REAL_UUID);
    assert.equal(normalizeClawBitsTarget("CLAWBITS:default"), "default");
    assert.equal(normalizeClawBitsTarget("clawbits:human:3"), "human:3");
  });

  it("passes already-bare ids through unchanged", () => {
    assert.equal(normalizeClawBitsTarget(REAL_UUID), REAL_UUID);
    assert.equal(normalizeClawBitsTarget("default"), "default");
  });

  it("returns undefined for empty / non-string input", () => {
    assert.equal(normalizeClawBitsTarget(""), undefined);
    assert.equal(normalizeClawBitsTarget("   "), undefined);
    assert.equal(normalizeClawBitsTarget(undefined as unknown as string), undefined);
  });
});

/** Build a minimal config that the resolver can chew on. The plugin's
 *  account resolver reads `channels.clawbits.accounts.<id>.channelId`. */
function cfgWith(configuredChannel: string | undefined) {
  return {
    channels: {
      clawbits: {
        accounts: {
          default: {
            endpoint: "http://fc",
            orgId: "user-1",
            agentId: "bot",
            apiKey: "k",
            ...(configuredChannel ? { channelId: configuredChannel } : {}),
          },
        },
      },
    },
  };
}

describe("messagingAdapter.targetResolver.resolveTarget", () => {
  const resolveTarget = messagingAdapter.targetResolver!.resolveTarget!;

  it("resolves `default` to the configured channel id", async () => {
    const out = await resolveTarget({
      cfg: cfgWith(REAL_UUID),
      accountId: "default",
      input: "default",
      normalized: "default",
    });
    assert.ok(out);
    assert.equal(out.to, REAL_UUID);
    assert.equal(out.kind, "channel");
  });

  it("passes UUID-shaped channel ids through as-is", async () => {
    const out = await resolveTarget({
      cfg: cfgWith(REAL_UUID),
      accountId: "default",
      input: REAL_UUID,
      normalized: REAL_UUID,
    });
    assert.ok(out);
    assert.equal(out.to, REAL_UUID);
  });

  it("maps peer-shaped targets back to the configured channel (codex tools.message case)", async () => {
    // This is the exact shape session.deliveryContext.to carries when the
    // codex bridge calls the message tool with no explicit channel.
    const out = await resolveTarget({
      cfg: cfgWith(REAL_UUID),
      accountId: "default",
      input: "clawbits:human:3",
      normalized: "human:3",
    });
    assert.ok(out);
    assert.equal(out.to, REAL_UUID);
    assert.equal(out.kind, "channel");
  });

  it("resolves a channel:<id> peer to that channel id (shared-channel reply)", async () => {
    // The route peer for a non-DM reply. Must resolve to the *named* channel,
    // not the configured owner DM — otherwise channel replies land in the DM.
    const out = await resolveTarget({
      cfg: cfgWith("11111111-2222-3333-4444-555555555555"),
      accountId: "default",
      input: `clawbits:channel:${REAL_UUID}`,
      normalized: `channel:${REAL_UUID}`,
    });
    assert.ok(out);
    assert.equal(out.to, REAL_UUID, "uses the channel id, not the fallback DM");
    assert.equal(out.kind, "channel");
  });

  it("returns null when no configured channel exists and the target is not a real id", async () => {
    const out = await resolveTarget({
      cfg: cfgWith(undefined),
      accountId: "default",
      input: "human:3",
      normalized: "human:3",
    });
    assert.equal(out, null);
  });
});

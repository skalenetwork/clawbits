import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ClawBitsClient } from "../src/client.js";
import {
  __resetTurnRegistryForTest,
  claimTurnForRun,
  registerInFlightTurn,
  turnForRun,
  unregisterInFlightTurn,
} from "../src/activity/turn-registry.js";

const fakeClient = {} as ClawBitsClient;

function makeTurn(channelId: string, channelKeyed: boolean) {
  return registerInFlightTurn({
    accountId: "default",
    channelId,
    draftRef: { id: 1 },
    client: fakeClient,
    channelKeyedSession: channelKeyed,
    streaming: true,
    liveActivity: true,
  });
}

describe("activity turn registry", () => {
  beforeEach(() => {
    __resetTurnRegistryForTest();
  });

  it("binds a channel-keyed turn by session-key suffix", () => {
    const chanTurn = makeTurn("chan-A", true);
    makeTurn("chan-B", true);
    const claimed = claimTurnForRun("run1", "agent:bot:clawbits:channel:chan-A");
    assert.equal(claimed, chanTurn);
    assert.equal(turnForRun("run1"), chanTurn);
    // Subsequent claims with the same runId return the bound turn without
    // consulting the session key again.
    assert.equal(claimTurnForRun("run1"), chanTurn);
  });

  it("binds the sole unbound DM turn without a channel-shaped key", () => {
    const dmTurn = makeTurn("dm-chan", false);
    const claimed = claimTurnForRun("run2", "agent:bot:main");
    assert.equal(claimed, dmTurn);
  });

  it("refuses ambiguous claims (two unbound DM turns)", () => {
    makeTurn("dm-1", false);
    makeTurn("dm-2", false);
    assert.equal(claimTurnForRun("run3", "agent:bot:main"), undefined);
  });

  it("refuses the DM fallback when a channel turn is also unbound", () => {
    // A DM turn plus an unbound channel turn whose key did not match: the
    // run could belong to either — do not guess.
    makeTurn("dm-1", false);
    makeTurn("chan-A", true);
    assert.equal(claimTurnForRun("run4", "agent:bot:main"), undefined);
  });

  it("unregister clears both indexes", () => {
    const turn = makeTurn("chan-A", true);
    claimTurnForRun("run5", "agent:bot:clawbits:channel:chan-A");
    unregisterInFlightTurn(turn);
    assert.equal(turnForRun("run5"), undefined);
    // The registry is empty again: a fresh DM turn is claimable as sole.
    const dm = makeTurn("dm", false);
    assert.equal(claimTurnForRun("run6"), dm);
  });

  it("ignores runs with no matching turn (cron/heartbeat)", () => {
    assert.equal(claimTurnForRun("run7", "agent:bot:cron:xyz"), undefined);
    assert.equal(claimTurnForRun(undefined), undefined);
  });
});

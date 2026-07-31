import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ENDPOINT,
  listClawBitsAccountIds,
  resolveDefaultClawBitsAccountId,
  resolveClawBitsAccount,
} from "../src/accounts.js";

describe("listClawBitsAccountIds", () => {
  it("returns ['default'] for an empty config", () => {
    assert.deepEqual(listClawBitsAccountIds({}), [DEFAULT_ACCOUNT_ID]);
  });

  it("returns ['default'] when the clawbits section has inline fields but no accounts.*", () => {
    const ids = listClawBitsAccountIds({
      channels: { clawbits: { ownerEmail: "o@o", agentId: "a" } },
    });
    assert.deepEqual(ids, [DEFAULT_ACCOUNT_ID]);
  });

  it("lists named accounts when only accounts.* is present", () => {
    const ids = listClawBitsAccountIds({
      channels: { clawbits: { accounts: { alice: {}, bob: {} } } },
    });
    assert.deepEqual(ids.sort(), ["alice", "bob"]);
  });

  it("includes 'default' alongside named accounts when top-level fields are also set", () => {
    const ids = listClawBitsAccountIds({
      channels: {
        clawbits: {
          ownerEmail: "o@o",
          accounts: { alice: {} },
        },
      },
    });
    assert.deepEqual(ids.sort(), ["alice", DEFAULT_ACCOUNT_ID].sort());
  });

  it("falls back to ['default'] when the channels object is malformed", () => {
    assert.deepEqual(
      listClawBitsAccountIds({ channels: "not-an-object" as unknown as never }),
      [DEFAULT_ACCOUNT_ID],
    );
  });
});

describe("resolveDefaultClawBitsAccountId", () => {
  it("returns 'default' for an empty config", () => {
    assert.equal(resolveDefaultClawBitsAccountId({}), DEFAULT_ACCOUNT_ID);
  });

  it("honors defaultAccount when set", () => {
    const id = resolveDefaultClawBitsAccountId({
      channels: {
        clawbits: {
          defaultAccount: "alice",
          accounts: { alice: {}, bob: {} },
        },
      },
    });
    assert.equal(id, "alice");
  });

  it("ignores whitespace-only defaultAccount", () => {
    const id = resolveDefaultClawBitsAccountId({
      channels: { clawbits: { defaultAccount: "   ", accounts: { alice: {} } } },
    });
    assert.equal(id, "alice");
  });
});

describe("resolveClawBitsAccount", () => {
  it("returns an unconfigured default account with sensible fallbacks", () => {
    const acct = resolveClawBitsAccount({ cfg: {} });
    assert.equal(acct.accountId, DEFAULT_ACCOUNT_ID);
    assert.equal(acct.configured, false);
    assert.equal(acct.enabled, true);
    assert.equal(acct.endpoint, DEFAULT_ENDPOINT);
    assert.equal(acct.ownerEmail, undefined);
    assert.equal(acct.agentId, undefined);
    assert.equal(acct.apiKey, undefined);
    assert.equal(acct.channelId, undefined);
    assert.deepEqual(acct.knownAnswers, {});
  });

  it("reports configured=true only when all four required fields are present", () => {
    const full = resolveClawBitsAccount({
      cfg: {
        channels: {
          clawbits: {
            endpoint: "http://x",
            ownerEmail: "o@o",
            agentId: "a1",
            apiKey: "k1",
            channelId: "ch1",
          },
        },
      },
    });
    assert.equal(full.configured, true);
    assert.equal(full.endpoint, "http://x");
    assert.equal(full.ownerEmail, "o@o");
    assert.equal(full.agentId, "a1");
    assert.equal(full.apiKey, "k1");
    assert.equal(full.channelId, "ch1");

    const missingApiKey = resolveClawBitsAccount({
      cfg: {
        channels: {
          clawbits: {
            endpoint: "http://x",
            ownerEmail: "o@o",
            agentId: "a1",
            channelId: "ch1",
          },
        },
      },
    });
    assert.equal(missingApiKey.configured, false);
  });

  it("merges accounts.<id> over the top-level section", () => {
    const acct = resolveClawBitsAccount({
      cfg: {
        channels: {
          clawbits: {
            endpoint: "http://default-host",
            ownerEmail: "default@owner",
            accounts: {
              alice: {
                ownerEmail: "alice@owner",
                agentId: "alice-agent",
                apiKey: "alice-key",
                channelId: "alice-ch",
              },
            },
          },
        },
      },
      accountId: "alice",
    });
    assert.equal(acct.accountId, "alice");
    assert.equal(acct.ownerEmail, "alice@owner", "override wins");
    assert.equal(acct.endpoint, "http://default-host", "top-level fills missing fields");
    assert.equal(acct.configured, true);
  });

  it("drops `accounts` and `defaultAccount` from the merged base", () => {
    const acct = resolveClawBitsAccount({
      cfg: {
        channels: {
          clawbits: {
            defaultAccount: "alice",
            accounts: { alice: { agentId: "a" } },
          },
        },
      },
      accountId: "alice",
    });
    // `config` is the merged slice handed to the adapter. It should not
    // contain the host-only bookkeeping keys.
    assert.equal((acct.config as Record<string, unknown>)["accounts"], undefined);
    assert.equal((acct.config as Record<string, unknown>)["defaultAccount"], undefined);
  });

  it("honours enabled=false at either level", () => {
    const topOff = resolveClawBitsAccount({
      cfg: { channels: { clawbits: { enabled: false } } },
    });
    assert.equal(topOff.enabled, false);

    const acctOff = resolveClawBitsAccount({
      cfg: {
        channels: {
          clawbits: { accounts: { alice: { enabled: false } } },
        },
      },
      accountId: "alice",
    });
    assert.equal(acctOff.enabled, false);
  });

  it("filters non-string values out of knownAnswers", () => {
    const acct = resolveClawBitsAccount({
      cfg: {
        channels: {
          clawbits: {
            knownAnswers: {
              "Q1?": "A1",
              "Q2?": 42 as unknown as string,
              "Q3?": null as unknown as string,
            },
          },
        },
      },
    });
    assert.deepEqual(acct.knownAnswers, { "Q1?": "A1" });
  });

  it("normalizes allowFrom sender aliases", () => {
    const acct = resolveClawBitsAccount({
      cfg: {
        channels: {
          clawbits: {
            allowFrom: ["human:7", " helper-agent ", 42, ""],
          },
        },
      },
    });
    assert.deepEqual(acct.allowFrom.sort(), [
      "42",
      "agent:helper-agent",
      "helper-agent",
      "human:42",
      "human:7",
      "human:helper-agent",
    ].sort());
  });

  it("normalises a missing/blank accountId to 'default'", () => {
    const a = resolveClawBitsAccount({ cfg: {}, accountId: "   " });
    assert.equal(a.accountId, DEFAULT_ACCOUNT_ID);

    const b = resolveClawBitsAccount({ cfg: {}, accountId: null });
    assert.equal(b.accountId, DEFAULT_ACCOUNT_ID);
  });
});

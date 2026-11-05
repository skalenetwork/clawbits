import { describe, expect, it } from "bun:test";
import {
  resolveInboundDispatchGuardTarget,
  withInboundDispatchGuard,
} from "../src/inbound-dispatch-guard.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("inbound dispatch guard", () => {
  it("serializes concurrent dispatches for one session", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withInboundDispatchGuard({ sessionKey: "session-a" }, async () => {
      events.push("first:start");
      await firstRelease;
      events.push("first:end");
    });

    while (!events.includes("first:start")) await sleep(5);

    const second = withInboundDispatchGuard({ sessionKey: "session-a" }, async () => {
      events.push("second:start");
    });

    await sleep(50);
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("keys the guard by the routed session", () => {
    const target = resolveInboundDispatchGuardTarget({
      cfg: { session: { store: "sessions.json" } },
      channel: "clawbits",
      accountId: "default",
      peer: { kind: "direct", id: "human:5" },
      runtime: {
        routing: {
          resolveAgentRoute: () => ({ agentId: "main", sessionKey: "agent:main:clawbits:direct:human:5" }),
        },
      },
    });

    expect(target).toEqual({
      sessionKey: "agent:main:clawbits:direct:human:5",
      agentId: "main",
    });
  });
});

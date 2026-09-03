import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runUpdateCommand } from "../src/tools/update.js";

// The plugin checkout root (this package dir) — a real dir that contains
// openclaw.plugin.json and update-from-source.sh.
const CHECKOUT = path.resolve(import.meta.dirname, "..");
// OpenClaw 2026.8 rejects `--pin` for `clawhub:` refs and requires
// `--accept-capabilities`; the pre-2026.8 form has neither option and is
// printed alongside as a fallback. Both are pinned here so a silent revert to
// the old single-command shape fails loudly.
const REMOTE_CMDS = [
  "openclaw plugins install clawhub:clawbits-openclaw-plugin --force --accept-capabilities",
  "openclaw plugins install clawhub:clawbits-openclaw-tools --force --accept-capabilities",
];
const REMOTE_FALLBACK_CMDS = [
  "openclaw plugins install clawhub:clawbits-openclaw-plugin --pin --force",
  "openclaw plugins install clawhub:clawbits-openclaw-tools --pin --force",
];

/** Capture stdout (JSON mode) while running `body`. Returns parsed events. */
function captureJson(run: () => number): { code: number; events: Record<string, unknown>[] } {
  const writes: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // @ts-expect-error narrow override for the test
  process.stdout.write = (chunk: string) => {
    writes.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  let code: number;
  try {
    code = run();
  } finally {
    process.stdout.write = origWrite;
  }
  const events = writes
    .join("")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { code, events };
}

function ctxWith(config: unknown) {
  return { config } as never;
}

describe("runUpdateCommand", () => {
  let stateDir: string;
  let prevState: string | undefined;

  beforeEach(() => {
    // Isolate the legacy-index fallback so on-disk records can't leak in.
    stateDir = mkdtempSync(path.join(tmpdir(), "clawbits-update-test-"));
    prevState = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_HOME;
    delete process.env.CLAWBITS_PLUGIN_SOURCE_DIR;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prevState;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("defaults to the remote upgrade commands, with the pre-2026.8 fallback", () => {
    const config = { plugins: { installs: { clawbits: { source: "clawhub", version: "0.4.16" } } } };
    const { code, events } = captureJson(() => runUpdateCommand(ctxWith(config), { json: true }));
    assert.equal(code, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.mode, "remote");
    assert.deepEqual(events[0]!.commands, REMOTE_CMDS);
    assert.deepEqual(events[0]!.fallback_commands, REMOTE_FALLBACK_CMDS);
    assert.equal(events[0]!.gateway_restart, true);
  });

  it("updates the tools companion too, not just the channel", () => {
    // Since 0.17 the install is a split pair and the companion owns cron,
    // email, usage and skills. A channel-only update succeeds, reports success,
    // and leaves every one of those services running the old code — so the
    // update an operator ran to pick up a cron or email fix silently does
    // nothing. Both packages must appear, channel first.
    const config = { plugins: { installs: { clawbits: { source: "clawhub", version: "0.4.16" } } } };
    const { events } = captureJson(() => runUpdateCommand(ctxWith(config), { json: true }));
    const commands = events[0]!.commands as string[];
    assert.equal(commands.length, 2);
    assert.ok(commands[0]!.includes("clawhub:clawbits-openclaw-plugin"));
    assert.ok(commands[1]!.includes("clawhub:clawbits-openclaw-tools"));
    assert.deepEqual(events[0]!.packages, [
      "clawbits-openclaw-plugin",
      "clawbits-openclaw-tools",
    ]);
  });

  it("never recommends --pin for a clawhub ref, which 2026.8 rejects outright", () => {
    const config = { plugins: { installs: { clawbits: { source: "clawhub", version: "0.4.16" } } } };
    const { events } = captureJson(() => runUpdateCommand(ctxWith(config), { json: true }));
    for (const command of events[0]!.commands as string[]) {
      assert.ok(command.includes("clawhub:"), "every command targets a clawhub ref");
      assert.ok(
        !command.includes("--pin"),
        "openclaw 2026.8 fails preflight with '--pin is only supported with npm registry installs.'",
      );
      assert.ok(command.includes("--accept-capabilities"));
    }
  });

  it("still recommends the remote commands when no record is found", () => {
    const { code, events } = captureJson(() => runUpdateCommand(ctxWith({}), { json: true }));
    assert.equal(code, 0);
    assert.equal(events[0]!.mode, "remote");
    assert.equal(events[0]!.install_source, "unknown");
    assert.deepEqual(events[0]!.commands, REMOTE_CMDS);
  });

  it("auto-routes a local (path) install to the from-source recipe", () => {
    const config = {
      plugins: { installs: { clawbits: { source: "path", sourcePath: CHECKOUT } } },
    };
    const { code, events } = captureJson(() => runUpdateCommand(ctxWith(config), { json: true }));
    assert.equal(code, 0);
    assert.equal(events[0]!.mode, "from-source");
    assert.equal(events[0]!.source_dir, CHECKOUT);
    assert.deepEqual(events[0]!.commands, [`bash ${CHECKOUT}/update-from-source.sh`]);
  });

  it("forces the from-source recipe via --from-source even for a remote source", () => {
    const config = { plugins: { installs: { clawbits: { source: "clawhub" } } } };
    const { code, events } = captureJson(() =>
      runUpdateCommand(ctxWith(config), { json: true, fromSource: true, dir: CHECKOUT }),
    );
    assert.equal(code, 0);
    assert.equal(events[0]!.mode, "from-source");
    assert.equal(events[0]!.source_dir, CHECKOUT);
  });

  it("errors when --from-source is requested without a resolvable dir", () => {
    const { code, events } = captureJson(() =>
      runUpdateCommand(ctxWith({}), { json: true, fromSource: true }),
    );
    assert.equal(code, 2);
    assert.equal(events[0]!.event, "needs_source_dir");
  });

  it("rejects a --dir that is not a plugin checkout", () => {
    const { code, events } = captureJson(() =>
      runUpdateCommand(ctxWith({}), { json: true, fromSource: true, dir: stateDir }),
    );
    assert.equal(code, 2);
    assert.equal(events[0]!.event, "invalid_source_dir");
  });
});

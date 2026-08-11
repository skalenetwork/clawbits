import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runUpdateCommand } from "../src/tools/update.js";

// The plugin checkout root (this package dir) — a real dir that contains
// openclaw.plugin.json and update-from-source.sh.
const CHECKOUT = path.resolve(import.meta.dirname, "..");
const PINNED_CMD =
  "openclaw plugins install clawhub:clawbits-openclaw-plugin --pin --force";

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

  it("defaults to the pinned-remote upgrade command", () => {
    const config = { plugins: { installs: { clawbits: { source: "clawhub", version: "0.4.16" } } } };
    const { code, events } = captureJson(() => runUpdateCommand(ctxWith(config), { json: true }));
    assert.equal(code, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.mode, "pinned-remote");
    assert.deepEqual(events[0]!.commands, [PINNED_CMD]);
    assert.equal(events[0]!.gateway_restart, true);
  });

  it("still recommends the pinned-remote command when no record is found", () => {
    const { code, events } = captureJson(() => runUpdateCommand(ctxWith({}), { json: true }));
    assert.equal(code, 0);
    assert.equal(events[0]!.mode, "pinned-remote");
    assert.equal(events[0]!.install_source, "unknown");
    assert.deepEqual(events[0]!.commands, [PINNED_CMD]);
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

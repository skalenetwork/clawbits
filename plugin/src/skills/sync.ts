// Skills sync: one pass is scan -> fetch desired -> apply -> report.
//
// Single owner loop per gateway: the skill roots are shared across accounts, so
// N loops would report the same skills N times and race each other's writes.
// All disk mutation lives in apply.ts; this module decides when to call it.

import type { ClawBitsClient } from "../client.js";
import { timedRequest } from "../client.js";
import { type BasicLogger, logInfo } from "../file-logger.js";
import { PLUGIN_VERSION } from "../version.js";
import { type DesiredSkill, applyDesired } from "./apply.js";
import { type ScannedSkill, resolveSkillRoots, scanSkills, writeRoot } from "./scan.js";

const STATE_PATH = "/api/agentic/skills/state";
const DESIRED_PATH = "/api/agentic/skills/desired";
export const SKILLS_REPORT_INTERVAL_MS = 300_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 1_800_000;
/** Chunk at the server cap so a tail is never silently dropped. */
const MAX_ITEMS = 500;

let owner: string | undefined;

export function claimSkillsReporter(accountId: string): boolean {
  if (owner !== undefined && owner !== accountId) return false;
  owner = accountId;
  return true;
}

export function releaseSkillsReporter(accountId: string): void {
  if (owner === accountId) owner = undefined;
}

export interface SkillsReporterOptions {
  client: ClawBitsClient;
  accountId: string;
  abortSignal: AbortSignal;
  /** From the gateway_start hook; falls back to the conventional layout. */
  workspaceDir?: string;
  extraDirs?: string[];
  runtimeVersion?: string;
  intervalMs?: number;
  log?: BasicLogger;
}

function toWire(s: ScannedSkill) {
  return {
    slug: s.slug,
    path: s.path,
    root: s.root,
    source: s.source,
    manifest: s.manifest,
  };
}

interface DesiredResponse {
  paused: boolean;
  skills: DesiredSkill[];
}

export async function syncOnce(opts: SkillsReporterOptions): Promise<number> {
  const { client, accountId, workspaceDir, extraDirs, runtimeVersion, log } = opts;
  const root = writeRoot(workspaceDir);

  const desired = await timedRequest<DesiredResponse>(
    client,
    "skills desired",
    "GET",
    DESIRED_PATH,
    { timeoutMs: REQUEST_TIMEOUT_MS, parent: opts.abortSignal },
  );

  // `paused` is the operator kill switch: still report, change nothing.
  const applied = desired.paused
    ? []
    : await applyDesired(root, desired.skills, {
        fetchVersion: (versionId) =>
          timedRequest<{ files: { path: string; content: string }[] }>(
            client,
            "skills version",
            "GET",
            `/api/agentic/skills/versions/${encodeURIComponent(versionId)}`,
            { timeoutMs: REQUEST_TIMEOUT_MS, parent: opts.abortSignal },
          ),
      });

  if (applied.length > 0) {
    // Tell the gateway to refresh rather than waiting on fs-watch timing, so
    // the skill is live on the very next turn. No-op on OpenClaw 2026.8+.
    await bumpSnapshot(workspaceDir, log, accountId);
  }

  // Scan AFTER applying so the report reflects the disk we just produced.
  const roots = resolveSkillRoots(workspaceDir, extraDirs);
  const { skills, scanned, truncated } = await scanSkills(roots);

  const body = {
    report_mode: "apply",
    plugin_version: PLUGIN_VERSION,
    runtime: "openclaw",
    runtime_version: runtimeVersion,
    skills_root: root,
    scanned_roots: scanned,
    apply_mode: "watch",
    truncated: truncated || skills.length > MAX_ITEMS,
    // On-disk skills, plus the outcomes of this pass. A removal is reported
    // here and nowhere else, since a removed skill is by definition not on disk.
    skills: [
      ...skills.slice(0, MAX_ITEMS).map(toWire),
      ...applied.map((a) => ({ ...a })),
    ],
  };

  await timedRequest<unknown>(client, "skills report", "POST", STATE_PATH, {
    json: body,
    timeoutMs: REQUEST_TIMEOUT_MS,
    parent: opts.abortSignal,
  });
  logInfo(
    log,
    `[clawbits/${accountId}] skills: ${String(applied.length)} applied, ${String(
      skills.length,
    )} on disk across ${String(scanned.length)} root(s)`,
  );
  return skills.length;
}

// `openclaw/plugin-sdk/skills-runtime` was DELETED in OpenClaw 2026.8 ("2.0").
// It is absent from the package's 324-subpath export map and from both
// `scripts/lib/plugin-sdk-entrypoints.json` and
// `plugin-sdk-private-local-only-subpaths.json` — not deprecated, not demoted
// to private-local, just gone, with no compatibility record and no public
// replacement. The three functions still exist inside the host
// (`src/skills/runtime/refresh-state.ts`) but nothing exposes them to a plugin.
//
// The imports stay because they are still the fast path on pre-2.0 gateways,
// which the reef image still pins. What changed is the honesty of the fallback:
// on 2.0 the poll is not a backstop, it is the ONLY path, so the degradation
// gets logged once instead of being swallowed. Symptom when it is missing: a
// freshly applied skill is not live until the host's own watcher or the next
// SKILLS_REPORT_INTERVAL_MS poll picks it up.
// NB: both `import()` calls below must keep this specifier INLINE as a string
// literal. `stage-artifact.mjs` walks the built closure and hard-fails with
// "unresolvable dynamic import" on a non-literal specifier, so hoisting it into
// this constant breaks packaging (test/staging.test.ts covers it). The constant
// exists for the log line only.
const SKILLS_RUNTIME_SUBPATH = "openclaw/plugin-sdk/skills-runtime";
let skillsRuntimeUnavailableLogged = false;

function noteSkillsRuntimeUnavailable(log: BasicLogger | undefined, accountId: string): void {
  if (skillsRuntimeUnavailableLogged) return;
  skillsRuntimeUnavailableLogged = true;
  logInfo(
    log,
    `[clawbits/${accountId}] skills: host does not expose ${SKILLS_RUNTIME_SUBPATH} ` +
      `(removed in OpenClaw 2026.8) — falling back to the ${SKILLS_REPORT_INTERVAL_MS}ms poll ` +
      `and the host's own skill watcher; newly applied skills are not live until then`,
  );
}

/** Ask OpenClaw to re-read its skill snapshot. Best-effort: the host's own file
 *  watcher is the fallback, this just removes the wait. Unavailable on 2.0+. */
async function bumpSnapshot(
  workspaceDir: string | undefined,
  log: BasicLogger | undefined,
  accountId: string,
): Promise<void> {
  try {
    const mod = (await import(
      /* @vite-ignore */ "openclaw/plugin-sdk/skills-runtime"
    )) as {
      bumpSkillsSnapshotVersion?: (p: { workspaceDir?: string; reason?: string }) => number;
    };
    if (typeof mod.bumpSkillsSnapshotVersion !== "function") {
      noteSkillsRuntimeUnavailable(log, accountId);
      return;
    }
    mod.bumpSkillsSnapshotVersion({ workspaceDir, reason: "clawbits-sync" });
  } catch {
    noteSkillsRuntimeUnavailable(log, accountId);
  }
}

/**
 * Report on a timer until `abortSignal` fires, plus immediately whenever
 * OpenClaw signals a skill change. Best-effort: every failure is logged and
 * swallowed, and never blocks the gateway.
 */
export async function runSkillsReporter(opts: SkillsReporterOptions): Promise<void> {
  const { client, accountId, abortSignal, log } = opts;
  const intervalMs = opts.intervalMs ?? SKILLS_REPORT_INTERVAL_MS;
  if (!client.hasApiKey()) {
    logInfo(log, `[clawbits/${accountId}] skills reporter idle: no api key`);
    return;
  }

  let dirty = false;
  let wakeSleep: (() => void) | undefined;
  const wake = () => {
    dirty = true;
    wakeSleep?.();
  };

  // OpenClaw's own change signal, when the host exposes it. Fires on any skill
  // create/update/removal — including the agent installing one itself — so the
  // mirror is fresh without shortening the poll. Gone on 2026.8+ (see
  // SKILLS_RUNTIME_SUBPATH above); there the poll is the only guarantee.
  let unsubscribe: (() => void) | undefined;
  try {
    const mod = (await import(
      /* @vite-ignore */ "openclaw/plugin-sdk/skills-runtime"
    )) as {
      registerSkillsChangeListener?: (fn: () => void) => () => void;
    };
    if (typeof mod.registerSkillsChangeListener === "function") {
      unsubscribe = mod.registerSkillsChangeListener(wake);
    } else {
      noteSkillsRuntimeUnavailable(log, accountId);
    }
  } catch {
    noteSkillsRuntimeUnavailable(log, accountId);
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (abortSignal.aborted || dirty) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", finish);
        wakeSleep = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      abortSignal.addEventListener("abort", finish, { once: true });
      wakeSleep = finish;
    });

  logInfo(log, `[clawbits/${accountId}] skills reporter started`);
  let failures = 0;
  try {
    while (!abortSignal.aborted) {
      // Cleared BEFORE the pass so a wake arriving mid-report is not erased.
      dirty = false;
      try {
        await syncOnce(opts);
        failures = 0;
      } catch (err) {
        failures += 1;
        log?.warn?.(
          `[clawbits/${accountId}] skills report failed (will retry): ${String(
            (err as Error)?.message ?? err,
          )}`,
        );
      }
      if (dirty && !abortSignal.aborted) continue;
      // Jitter so a fleet started together does not poll in lockstep, and back
      // off so an outage does not produce a synchronized retry storm.
      const backoff = failures > 0 ? Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS) : intervalMs;
      await sleep(Math.round(backoff * (0.85 + Math.random() * 0.3)));
    }
  } finally {
    unsubscribe?.();
  }
}

// Skills sync: one pass is fetch desired -> apply -> scan -> report.

import { setTimeout as sleep } from "node:timers/promises";
import { type ClawBitsClient, timedRequest } from "../client.js";
import { type BasicLogger, logInfo, logWarn } from "../file-logger.js";
import { PLUGIN_VERSION } from "../version.js";
import { type DesiredSkill, applyDesired } from "./apply.js";
import { type ScannedSkill, resolveBundledSkillsDir, resolveSkillRoots, scanSkills, writeRoot } from "./scan.js";

const INTERVAL_MS = 300_000;
const MAX_BACKOFF_MS = 1_800_000;
const REQUEST_TIMEOUT_MS = 20_000;

interface SkillsReporterOptions {
  client: ClawBitsClient;
  accountId: string;
  abortSignal: AbortSignal;
  workspaceDir?: string;
  runtimeVersion?: string;
  log?: BasicLogger;
}

/**
 * What the server holds from this reporter's successful reports: per slug, the
 * SKILL.md hash it has the text of, and the last bundled set. Advanced only
 * after a report succeeds, so a failed one resends everything it carried.
 */
export interface Reported {
  bodies: Map<string, string>;
  bundled?: string;
}

// `openclaw/plugin-sdk/skills-runtime` was deleted in OpenClaw 2026.8 with no
// public replacement, but older gateways (the reef image still pins one) expose
// it as the fast path. The specifier must stay an inline string literal:
// stage-artifact.mjs rejects any other dynamic import (test/staging.test.ts).
let skillsRuntime: Promise<Partial<typeof import("openclaw/plugin-sdk/skills-runtime")>> | undefined;

function loadSkillsRuntime(log: BasicLogger | undefined, accountId: string) {
  skillsRuntime ??= import("openclaw/plugin-sdk/skills-runtime").catch(() => {
    logInfo(
      log,
      `[clawbits/${accountId}] skills: host lacks openclaw/plugin-sdk/skills-runtime (OpenClaw 2026.8+); ` +
        "applied skills go live on the host's own watcher or the next poll",
    );
    return {};
  });
  return skillsRuntime;
}

function toWire({ skillMd: md, ...skill }: ScannedSkill, bodies: Map<string, string>) {
  return {
    ...skill,
    content_hash: md?.hash,
    ...(md && md.text === undefined ? { skill_md_omitted: "too_large" } : {}),
    ...(md?.text !== undefined && bodies.get(skill.slug) !== md.hash ? { skill_md: md.text } : {}),
  };
}

export async function syncOnce(opts: SkillsReporterOptions, reported: Reported): Promise<void> {
  const { client, accountId, workspaceDir, log } = opts;
  const request = <T>(label: string, method: string, subpath: string, json?: unknown) =>
    timedRequest<T>(client, `skills ${label}`, method, `/api/agentic/skills/${subpath}`, {
      json,
      timeoutMs: REQUEST_TIMEOUT_MS,
      parent: opts.abortSignal,
    });
  const root = writeRoot(workspaceDir);
  const desired = await request<{ paused: boolean; skills: DesiredSkill[] }>("desired", "GET", "desired");
  // `paused` is the operator kill switch: still report, change nothing.
  const applied = desired.paused
    ? []
    : await applyDesired(root, desired.skills, (versionId) =>
        request("version", "GET", `versions/${encodeURIComponent(versionId)}`),
      );
  if (applied.length > 0) {
    // Best-effort refresh rather than fs-watch timing, so the skill is live next turn.
    await loadSkillsRuntime(log, accountId)
      .then((rt) => rt.bumpSkillsSnapshotVersion?.({ workspaceDir, reason: "clawbits-sync" }))
      .catch(() => undefined);
  }

  // Scanned after applying so the report reflects the disk just produced.
  const { skills, scanned, truncated } = await scanSkills(resolveSkillRoots(workspaceDir));
  const bundledDir = await resolveBundledSkillsDir();
  const bundled = bundledDir
    ? (await scanSkills([bundledDir])).skills.map((s) => ({ slug: s.slug, description: s.manifest?.description }))
    : undefined;
  const bundledKey = bundled && JSON.stringify(bundled);

  await request("report", "POST", "state", {
    report_mode: "apply",
    plugin_version: PLUGIN_VERSION,
    runtime: "openclaw",
    runtime_version: opts.runtimeVersion,
    skills_root: root,
    scanned_roots: scanned,
    apply_mode: "watch",
    truncated,
    // A removal is reported here and nowhere else, since it is not on disk.
    skills: [...skills.map((s) => toWire(s, reported.bodies)), ...applied],
    // Absent means unchanged, so it goes up once per start and on change.
    ...(bundledKey && bundledKey !== reported.bundled ? { bundled } : {}),
  });
  // Rebuilt rather than added to: a skill that left the disk drops out, so its
  // text goes up again if it comes back. A confirmed removal deletes the
  // server's row, so a same-named copy in a lower root goes up again too.
  const removed = new Set(applied.filter((a) => a.status === "removed").map((a) => a.slug));
  reported.bodies = new Map(
    skills.flatMap((s) => (s.skillMd && !removed.has(s.slug) ? [[s.slug, s.skillMd.hash] as const] : [])),
  );
  if (bundledKey) reported.bundled = bundledKey;
  logInfo(
    log,
    `[clawbits/${accountId}] skills: ${applied.length} applied, ${skills.length} on disk across ${scanned.length} root(s)`,
  );
}

let wakeup: AbortController | undefined;

/** Cut the running reporter's sleep short; the channel forwards the server's
 *  `skills.sync` nudge here. */
export function wakeSkillsReporter(): void {
  wakeup?.abort();
}

/** Report on a timer until `abortSignal` fires, and at once on a wake. Every
 *  failure is logged and retried, and never blocks the gateway. */
export async function runSkillsReporter(opts: SkillsReporterOptions): Promise<void> {
  const { accountId, abortSignal, log } = opts;
  // OpenClaw's own change signal also catches skills the agent installs itself.
  const unsubscribe = await loadSkillsRuntime(log, accountId)
    .then((rt) => rt.registerSkillsChangeListener?.(wakeSkillsReporter))
    .catch(() => undefined);
  logInfo(log, `[clawbits/${accountId}] skills reporter started`);
  const reported: Reported = { bodies: new Map() };
  let failures = 0;
  try {
    while (!abortSignal.aborted) {
      // Armed before the pass so a wake arriving mid-report is not lost.
      wakeup = new AbortController();
      const signal = AbortSignal.any([abortSignal, wakeup.signal]);
      try {
        await syncOnce(opts, reported);
        failures = 0;
      } catch (err) {
        failures += 1;
        logWarn(log, `[clawbits/${accountId}] skills report failed (will retry): ${String((err as Error)?.message ?? err)}`);
      }
      // Jitter so a fleet started together does not poll in lockstep, and back
      // off so an outage does not produce a synchronized retry storm.
      const delay = Math.min(INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS) * (0.85 + Math.random() * 0.3);
      await sleep(Math.round(delay), undefined, { signal }).catch(() => undefined);
    }
  } finally {
    wakeup = undefined;
    unsubscribe?.();
  }
}

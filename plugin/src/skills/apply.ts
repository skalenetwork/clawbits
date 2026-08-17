// The only module that writes or deletes on disk.
//
// Two rules make this safe:
//   1. Nothing is written unless the content hash actually differs (the drift
//      gate). Rewriting an unchanged skill would bump mtime and retrigger the
//      gateway's watcher on every pass, forever.
//   2. Nothing is reported as removed unless it is verifiably gone. Reporting a
//      failed delete as success is how the automations reconciler destroys run
//      history and then resurrects the job.

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Our marker, written last so a half-written skill is never claimed as ours. */
const MARKER_DIR = ".clawbits";
const MARKER_FILE = "origin.json";
const STAGING_DIR = ".clawbits-staging";

export interface SkillMarker {
  version: 1;
  installId: string;
  slug: string;
  contentHash: string;
  installedAt: string;
}

export interface DesiredSkill {
  install_id: string;
  slug: string;
  intent: "present" | "absent";
  desired_generation: number;
  version_id: string | null;
  content_hash: string | null;
}

export interface ApplyResult {
  install_id: string;
  slug: string;
  observed_generation: number;
  status: "applied" | "removed" | "failed";
  error?: string;
  content_hash?: string;
  path?: string;
}

export async function readMarker(dir: string): Promise<SkillMarker | undefined> {
  try {
    const raw = await readFile(path.join(dir, MARKER_DIR, MARKER_FILE), "utf-8");
    const parsed = JSON.parse(raw) as SkillMarker;
    return typeof parsed.contentHash === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a skill directory atomically: build it in staging, then swap it in.
 *
 * The rename is what keeps the gateway's watcher from ever seeing a partially
 * written skill — it either sees the old one or the new one.
 */
async function materialize(
  root: string,
  item: DesiredSkill,
  files: { path: string; content: string }[],
): Promise<string> {
  const staging = path.join(root, STAGING_DIR, item.install_id);
  const target = path.join(root, item.slug);

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  for (const file of files) {
    const dest = path.join(staging, file.path);
    // Defence in depth: the server validates paths, but this process deletes
    // directories, so it re-checks rather than trusting the wire.
    if (!dest.startsWith(staging + path.sep)) {
      throw new Error(`refusing to write outside the skill directory: ${file.path}`);
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, file.content, "utf-8");
  }

  const marker: SkillMarker = {
    version: 1,
    installId: item.install_id,
    slug: item.slug,
    contentHash: item.content_hash ?? "",
    installedAt: new Date().toISOString(),
  };
  await mkdir(path.join(staging, MARKER_DIR), { recursive: true });
  await writeFile(
    path.join(staging, MARKER_DIR, MARKER_FILE),
    JSON.stringify(marker, null, 2),
    "utf-8",
  );

  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
  return target;
}

/** Delete a skill we own, and confirm it. */
async function removeSkill(root: string, slug: string): Promise<void> {
  const target = path.join(root, slug);
  await rm(target, { recursive: true, force: true });
  if (await exists(target)) {
    throw new Error(`${target} still exists after removal`);
  }
}

export interface ApplyDeps {
  /** Fetch a version's files. Called only when the local hash differs. */
  fetchVersion: (versionId: string) => Promise<{ files: { path: string; content: string }[] }>;
}

/**
 * Converge one desired item. Returns null when nothing needed doing, so the
 * caller can tell a real no-op from a write.
 */
export async function applyOne(
  root: string,
  item: DesiredSkill,
  deps: ApplyDeps,
): Promise<ApplyResult | null> {
  const target = path.join(root, item.slug);
  const marker = await readMarker(target);

  if (item.intent === "absent") {
    // Only ever delete a directory carrying OUR marker. An unmarked directory
    // of the same name is the user's own skill.
    if (!(await exists(target))) {
      return { ...base(item), status: "removed" };
    }
    if (!marker) {
      return {
        ...base(item),
        status: "failed",
        error: "a skill of that name exists but was not installed by Clawbits",
      };
    }
    try {
      await removeSkill(root, item.slug);
      return { ...base(item), status: "removed" };
    } catch (err) {
      return { ...base(item), status: "failed", error: msg(err) };
    }
  }

  if (!item.version_id || !item.content_hash) {
    return { ...base(item), status: "failed", error: "no published version to install" };
  }

  // The drift gate.
  if (marker?.contentHash === item.content_hash) return null;

  // Refuse to overwrite a directory we do not own.
  if (!marker && (await exists(target))) {
    return {
      ...base(item),
      status: "failed",
      error: "a skill of that name already exists on this agent",
    };
  }

  try {
    const { files } = await deps.fetchVersion(item.version_id);
    const written = await materialize(root, item, files);
    return { ...base(item), status: "applied", content_hash: item.content_hash, path: written };
  } catch (err) {
    return { ...base(item), status: "failed", error: msg(err) };
  }
}

function base(item: DesiredSkill) {
  return {
    install_id: item.install_id,
    slug: item.slug,
    observed_generation: item.desired_generation,
  };
}

function msg(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 500);
}

/** Apply the whole desired set. Absent items go first, so a slug being freed
 *  never collides with one being taken in the same pass. */
export async function applyDesired(
  root: string,
  items: DesiredSkill[],
  deps: ApplyDeps,
): Promise<ApplyResult[]> {
  await mkdir(root, { recursive: true });
  const ordered = [...items].sort((a, b) => (a.intent === "absent" ? -1 : 0) - (b.intent === "absent" ? -1 : 0));
  const out: ApplyResult[] = [];
  for (const item of ordered) {
    const result = await applyOne(root, item, deps);
    if (result) out.push(result);
  }
  // Staging is scratch; leaving it behind would look like a skill named
  // ".clawbits-staging" to nothing, but it still shouldn't accumulate.
  await rm(path.join(root, STAGING_DIR), { recursive: true, force: true });
  return out;
}

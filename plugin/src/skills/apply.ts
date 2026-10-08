// The only module that writes or deletes on disk. Two rules make it safe:
//   1. Nothing is written unless the content hash differs (the drift gate).
//      Rewriting an unchanged skill would retrigger the gateway's watcher on
//      every pass, forever.
//   2. Nothing is reported removed unless it is verifiably gone; reporting a
//      failed delete as success makes the server drop a skill still on disk.

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Our marker, written last so a half-written skill is never claimed as ours. */
const MARKER = path.join(".clawbits", "origin.json");
const STAGING_DIR = ".clawbits-staging";
/** The server's slug rule, enforced here too because a slug is a path segment
 *  of something this module deletes. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;

interface SkillMarker {
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
  /** Adopt: may replace an unmanaged directory of the same slug in this root. */
  takeover?: boolean;
}

interface ApplyResult {
  install_id: string;
  slug: string;
  observed_generation: number;
  status: "applied" | "removed" | "failed";
  error?: string;
  content_hash?: string;
  path?: string;
}

type SkillFile = { path: string; content: string };
/** Fetch a version's files. Called only when the local hash differs. */
type FetchVersion = (versionId: string) => Promise<{ files: SkillFile[] }>;

export async function readMarker(dir: string): Promise<SkillMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, MARKER), "utf-8")) as SkillMarker;
    return typeof parsed.contentHash === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const exists = (target: string) => stat(target).then(() => true, () => false);

/** Build the skill in staging, then rename it in, so the gateway's watcher sees
 *  either the old skill or the new one and never a partial write. */
async function materialize(root: string, item: DesiredSkill, files: SkillFile[]): Promise<void> {
  const staging = path.join(root, STAGING_DIR, item.install_id);
  const target = path.join(root, item.slug);
  await rm(staging, { recursive: true, force: true });
  const marker: SkillMarker = {
    version: 1,
    installId: item.install_id,
    slug: item.slug,
    contentHash: item.content_hash ?? "",
    installedAt: new Date().toISOString(),
  };
  for (const file of [...files, { path: MARKER, content: JSON.stringify(marker, null, 2) }]) {
    const dest = path.join(staging, file.path);
    // The server validates paths too, but this process deletes directories.
    if (!dest.startsWith(staging + path.sep)) {
      throw new Error(`refusing to write outside the skill directory: ${file.path}`);
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, file.content, "utf-8");
  }
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
}

/** Converge one desired item; null when nothing needed doing. */
export async function applyOne(
  root: string,
  item: DesiredSkill,
  fetchVersion: FetchVersion,
): Promise<ApplyResult | null> {
  const base = { install_id: item.install_id, slug: item.slug, observed_generation: item.desired_generation };
  const fail = (error: unknown): ApplyResult => ({
    ...base,
    status: "failed",
    error: String((error as Error)?.message ?? error).slice(0, 500),
  });
  if (!SLUG.test(item.slug)) return fail(`invalid skill slug: ${item.slug}`);
  const target = path.join(root, item.slug);
  const marker = await readMarker(target);

  if (item.intent === "absent") {
    if (!(await exists(target))) return { ...base, status: "removed" };
    // An unmarked directory of the same name is the user's own skill.
    if (!marker) return fail("a skill of that name exists but was not installed by Clawbits");
    const error = await rm(target, { recursive: true, force: true }).then(() => undefined, (err: unknown) => err);
    return (await exists(target)) ? fail(error ?? `${target} still exists after removal`) : { ...base, status: "removed" };
  }

  if (!item.version_id || !item.content_hash) return fail("no published version to install");
  // The drift gate. Another install's marker is an orphan (a slug has one
  // install per agent), so the folder is rewritten once to carry ours.
  if (marker?.contentHash === item.content_hash && marker.installId === item.install_id) return null;
  // Adopt is the only way over a directory we do not own.
  if (!marker && !item.takeover && (await exists(target))) {
    return fail("a skill of that name already exists on this agent");
  }
  try {
    const { files } = await fetchVersion(item.version_id);
    await materialize(root, item, files);
    return { ...base, status: "applied", content_hash: item.content_hash, path: target };
  } catch (err) {
    return fail(err);
  }
}

/** Apply the whole desired set. Removals go first, so a slug being freed never
 *  collides with one being taken in the same pass. */
export async function applyDesired(
  root: string,
  items: DesiredSkill[],
  fetchVersion: FetchVersion,
): Promise<ApplyResult[]> {
  await mkdir(root, { recursive: true });
  const out: ApplyResult[] = [];
  for (const item of [...items].sort((a, b) => Number(b.intent === "absent") - Number(a.intent === "absent"))) {
    const result = await applyOne(root, item, fetchVersion);
    if (result) out.push(result);
  }
  await rm(path.join(root, STAGING_DIR), { recursive: true, force: true });
  return out;
}

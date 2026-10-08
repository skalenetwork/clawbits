// Read-only scan of the agent's skill directories. A skill is any directory
// holding SKILL.md, however it arrived: baked into the image, installed over the
// terminal, or installed by the agent itself. All writes live in apply.ts.

import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const SKILL_MARKERS = ["SKILL.md", "skill.md"];
/** OpenClaw's own per-skill provenance marker, written by `skills install`. */
const OPENCLAW_ORIGIN = path.join(".openclaw", "source-origin.json");
/** Discovery recurses, but a runaway tree must not stall the loop. */
const MAX_DEPTH = 4;
/** Also the server's per-report cap. */
const MAX_SKILLS = 500;
/** SKILL.md text past this is hashed but never sent. */
export const MAX_SKILL_MD_BYTES = 64 * 1024;

type Manifest = { name?: string; description?: string };

export interface ScannedSkill {
  slug: string;
  path: string;
  root: string;
  /** From OpenClaw's marker when present: "clawhub" | "path" | "git" | … */
  source?: string;
  manifest?: Manifest;
  /** Absent only when SKILL.md could not be read. `text` is absent past
   *  MAX_SKILL_MD_BYTES. */
  skillMd?: { hash: string; text?: string };
}

const isDirectory = (target: string) => stat(target).then((s) => s.isDirectory(), () => false);
const isFile = (target: string) => stat(target).then((s) => s.isFile(), () => false);
const readJson = (file: string) =>
  readFile(file, "utf-8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown> | null)
    .catch(() => undefined);

/** Only name + description: we are not the loader. */
function parseFrontmatter(text: string): Manifest {
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  const out: Manifest = {};
  if (end === -1) return out;
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^(name|description):\s*(.*)$/u.exec(line.trim());
    if (m) out[m[1] as keyof Manifest] = (m[2] ?? "").replace(/^(["'])(.*)\1$/u, "$2");
  }
  return out;
}

async function readSkillMd(file: string): Promise<Pick<ScannedSkill, "manifest" | "skillMd">> {
  const raw = await readFile(file).catch(() => undefined);
  if (!raw) return {};
  const text = raw.toString("utf-8");
  return {
    manifest: parseFrontmatter(text),
    skillMd: {
      hash: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      ...(raw.length <= MAX_SKILL_MD_BYTES ? { text } : {}),
    },
  };
}

async function findSkillMd(dir: string): Promise<string | undefined> {
  for (const name of SKILL_MARKERS) if (await isFile(path.join(dir, name))) return path.join(dir, name);
  return undefined;
}

async function walk(dir: string, root: string, depth: number, out: ScannedSkill[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= MAX_SKILLS) return;
    if (entry.name.startsWith(".")) continue;
    const child = path.join(dir, entry.name);
    // Plugin-shipped skills are symlinks, and Dirent.isDirectory() is false for one.
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await isDirectory(child)))) continue;
    const file = await findSkillMd(child);
    if (!file) {
      await walk(child, root, depth + 1, out);
      continue;
    }
    const origin = await readJson(path.join(child, OPENCLAW_ORIGIN));
    out.push({
      // Identity is the directory name: OpenClaw requires frontmatter `name`
      // to equal it, and the directory is what we would write.
      slug: entry.name,
      path: file,
      root,
      source: typeof origin?.source === "string" ? origin.source : undefined,
      ...(await readSkillMd(file)),
    });
  }
}

/**
 * Roots to scan, highest precedence first. Excludes OpenClaw's bundled skills,
 * identical on every agent of an image; they go up as a slim list instead (see
 * resolveBundledSkillsDir). `plugin-skills` holds the clawbits-* skills, which
 * an org skill of the same name would shadow.
 */
export function resolveSkillRoots(workspaceDir: string | undefined): string[] {
  const home = homedir();
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.OPENCLAW_HOME?.trim() ||
    path.join(home, ".openclaw");
  const workspace = workspaceDir?.trim() || path.join(stateDir, "workspace");
  return [
    ...new Set([
      path.join(workspace, "skills"),
      path.join(workspace, ".agents", "skills"),
      path.join(home, ".agents", "skills"),
      path.join(stateDir, "skills"),
      path.join(stateDir, "plugin-skills"),
    ]),
  ];
}

/** The root apply.ts writes to: highest precedence, and on reef the only path
 *  that survives a VM upgrade. */
export function writeRoot(workspaceDir: string | undefined): string {
  return resolveSkillRoots(workspaceDir)[0] as string;
}

/**
 * OpenClaw's bundled skills (`<install>/skills`), found the way the host finds
 * them: its OPENCLAW_BUNDLED_SKILLS_DIR override, else the `openclaw` package
 * root above the gateway's entry script (`/app/openclaw.mjs` on reef, a global
 * bin symlink elsewhere).
 */
export async function resolveBundledSkillsDir(
  entry = process.argv[1],
): Promise<string | undefined> {
  const override = process.env.OPENCLAW_BUNDLED_SKILLS_DIR?.trim();
  if (override) return (await isDirectory(override)) ? override : undefined;
  if (!entry) return undefined;
  for (let dir = path.dirname(await realpath(entry).catch(() => entry)); ; dir = path.dirname(dir)) {
    if ((await readJson(path.join(dir, "package.json")))?.name === "openclaw") {
      const skills = path.join(dir, "skills");
      return (await isDirectory(skills)) ? skills : undefined;
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

export async function scanSkills(roots: string[]) {
  const out: ScannedSkill[] = [];
  const scanned: string[] = [];
  for (const root of roots) {
    if (!(await isDirectory(root))) continue;
    scanned.push(root);
    await walk(root, root, 0, out);
  }
  // First root wins on a duplicate slug, matching OpenClaw's precedence.
  const seen = new Set<string>();
  const skills = out.filter((s) => !seen.has(s.slug) && seen.add(s.slug));
  return { skills, scanned, truncated: out.length >= MAX_SKILLS };
}

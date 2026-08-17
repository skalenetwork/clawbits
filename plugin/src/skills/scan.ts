// Read-only scan of the agent's skill directories.
//
// OpenClaw discovers skills from several roots, and a skill is any directory
// containing SKILL.md (or skill.md). We report everything we find so the
// operator can see skills that arrived any way at all — baked into the image,
// installed over the terminal, or installed by the agent itself when a human
// said "install X from ClawHub".
//
// Nothing here writes. That is the M2 safety property, and it is a property of
// the code rather than a flag: there is no write path to disable.

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const SKILL_MARKERS = ["SKILL.md", "skill.md"];
/** OpenClaw's own per-skill provenance marker, written by `skills install`. */
const OPENCLAW_ORIGIN = path.join(".openclaw", "source-origin.json");
/** Discovery recurses, but a runaway tree must not stall the loop. */
const MAX_DEPTH = 4;
const MAX_SKILLS = 500;

export interface ScannedSkill {
  slug: string;
  path: string;
  root: string;
  /** From OpenClaw's marker when present: "clawhub" | "path" | "git" | … */
  source?: string;
  manifest?: { name?: string; description?: string };
}

/** Frontmatter we care about: name + description. Anything else is the
 *  runtime's business, and we are not the loader. */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (m[1] === "name") out.name = value;
    else out.description = value;
  }
  return out;
}

async function readMarker(dir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(dir, OPENCLAW_ORIGIN), "utf-8");
    const parsed = JSON.parse(raw) as { source?: unknown };
    return typeof parsed.source === "string" ? parsed.source : undefined;
  } catch {
    return undefined;
  }
}

async function findMarkerFile(dir: string): Promise<string | undefined> {
  for (const name of SKILL_MARKERS) {
    const candidate = path.join(dir, name);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // not this one
    }
  }
  return undefined;
}

async function walk(
  dir: string,
  root: string,
  depth: number,
  out: ScannedSkill[],
): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_SKILLS) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SKILLS) return;
    if (entry.name.startsWith(".")) continue;
    // Plugin-shipped skills are SYMLINKS to the extension's own directory, and
    // Dirent.isDirectory() is false for a symlink — so stat through it.
    const child = path.join(dir, entry.name);
    if (!entry.isDirectory()) {
      if (!entry.isSymbolicLink()) continue;
      try {
        if (!(await stat(child)).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    const marker = await findMarkerFile(child);
    if (marker) {
      let manifest: { name?: string; description?: string } | undefined;
      try {
        manifest = parseFrontmatter(await readFile(marker, "utf-8"));
      } catch {
        manifest = undefined;
      }
      out.push({
        // Identity is the directory name: OpenClaw requires frontmatter `name`
        // to equal it, and the directory is what we would write.
        slug: entry.name,
        path: marker,
        root,
        source: await readMarker(child),
        manifest,
      });
      continue;
    }
    await walk(child, root, depth + 1, out);
  }
}

/**
 * Roots to scan, highest precedence first.
 *
 * Excludes OpenClaw's bundled skills (`<install>/skills`): they are identical
 * on every agent running the same image, so reporting them would add ~50 rows
 * of noise per agent and tell the operator nothing. Everything here is
 * agent-specific — including `plugin-skills`, where the clawbits-* skills live,
 * which is what an org skill of the same name would shadow.
 */
export function resolveSkillRoots(workspaceDir: string | undefined, extraDirs: string[] = []): string[] {
  const home = homedir();
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.OPENCLAW_HOME?.trim() ||
    path.join(home, ".openclaw");
  const workspace = workspaceDir?.trim() || path.join(stateDir, "workspace");
  const roots = [
    path.join(workspace, "skills"),
    path.join(workspace, ".agents", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(stateDir, "skills"),
    path.join(stateDir, "plugin-skills"),
    ...extraDirs,
  ];
  return [...new Set(roots)];
}

/** The root we would write to, if we could. Highest precedence, and on reef the
 *  only path that survives a VM upgrade. */
export function writeRoot(workspaceDir: string | undefined): string {
  return resolveSkillRoots(workspaceDir)[0] as string;
}

export async function scanSkills(roots: string[]): Promise<{
  skills: ScannedSkill[];
  scanned: string[];
  truncated: boolean;
}> {
  const out: ScannedSkill[] = [];
  const scanned: string[] = [];
  for (const root of roots) {
    try {
      if (!(await stat(root)).isDirectory()) continue;
    } catch {
      continue;
    }
    scanned.push(root);
    await walk(root, root, 0, out);
  }
  // First root wins on a duplicate slug, matching OpenClaw's precedence.
  const seen = new Set<string>();
  const deduped = out.filter((s) => {
    if (seen.has(s.slug)) return false;
    seen.add(s.slug);
    return true;
  });
  return { skills: deduped, scanned, truncated: out.length >= MAX_SKILLS };
}

// The workspace dir handed to us by the gateway_start hook. The SDK types the
// hook context loosely, so this is best-effort; every consumer falls back to
// the conventional layout.
let capturedWorkspaceDir: string | undefined;

export function setWorkspaceDir(dir: string | undefined): void {
  if (typeof dir === "string" && dir.trim()) capturedWorkspaceDir = dir.trim();
}

export function getWorkspaceDir(): string | undefined {
  return capturedWorkspaceDir;
}

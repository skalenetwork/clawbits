import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSkillRoots, scanSkills, writeRoot } from "../src/skills/scan.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "skills-scan-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeSkill(root: string, slug: string, frontmatter: string, origin?: string) {
  const skillDir = path.join(root, slug);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\nbody\n`);
  if (origin) {
    await mkdir(path.join(skillDir, ".openclaw"), { recursive: true });
    await writeFile(
      path.join(skillDir, ".openclaw", "source-origin.json"),
      JSON.stringify({ version: 1, source: origin, slug }),
    );
  }
}

describe("scanSkills", () => {
  test("finds skills and parses name + description", async () => {
    const root = path.join(dir, "skills");
    await writeSkill(root, "weather", 'name: "weather"\ndescription: "Get the weather."');

    const { skills, scanned } = await scanSkills([root]);
    expect(scanned).toEqual([root]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.slug).toBe("weather");
    expect(skills[0]?.manifest?.name).toBe("weather");
    expect(skills[0]?.manifest?.description).toBe("Get the weather.");
  });

  test("reads provenance from OpenClaw's own marker", async () => {
    const root = path.join(dir, "skills");
    await writeSkill(root, "fromhub", "name: fromhub\ndescription: d", "clawhub");
    const { skills } = await scanSkills([root]);
    expect(skills[0]?.source).toBe("clawhub");
  });

  test("ignores directories with no SKILL.md and missing roots", async () => {
    const root = path.join(dir, "skills");
    await mkdir(path.join(root, "notaskill"), { recursive: true });
    const { skills, scanned } = await scanSkills([root, path.join(dir, "absent")]);
    expect(skills).toHaveLength(0);
    expect(scanned).toEqual([root]);
  });

  test("first root wins on a duplicate slug, matching OpenClaw precedence", async () => {
    const high = path.join(dir, "high");
    const low = path.join(dir, "low");
    await writeSkill(high, "dupe", 'name: dupe\ndescription: "from high"');
    await writeSkill(low, "dupe", 'name: dupe\ndescription: "from low"');
    const { skills } = await scanSkills([high, low]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.manifest?.description).toBe("from high");
    expect(skills[0]?.root).toBe(high);
  });

  test("follows symlinked skills — plugin-shipped ones are symlinks", async () => {
    const real = path.join(dir, "extension", "skills");
    await writeSkill(real, "clawbits-email", "name: clawbits-email\ndescription: d");
    const root = path.join(dir, "plugin-skills");
    await mkdir(root, { recursive: true });
    await symlink(path.join(real, "clawbits-email"), path.join(root, "clawbits-email"));

    const { skills } = await scanSkills([root]);
    expect(skills.map((s) => s.slug)).toEqual(["clawbits-email"]);
  });

  test("finds skills nested below a root", async () => {
    const root = path.join(dir, "skills");
    await writeSkill(path.join(root, "group"), "nested", "name: nested\ndescription: d");
    const { skills } = await scanSkills([root]);
    expect(skills[0]?.slug).toBe("nested");
  });
});

describe("resolveSkillRoots", () => {
  test("puts the workspace root first — highest precedence and the only reef-persistent path", () => {
    const roots = resolveSkillRoots("/ws");
    expect(roots[0]).toBe(path.join("/ws", "skills"));
    expect(writeRoot("/ws")).toBe(path.join("/ws", "skills"));
  });

  test("includes the state and plugin-skills dirs, and dedupes", () => {
    const roots = resolveSkillRoots("/ws", ["/ws/skills"]);
    expect(new Set(roots).size).toBe(roots.length);
    expect(roots.some((r) => r.endsWith(path.join(".openclaw", "skills")))).toBe(true);
    expect(roots.some((r) => r.endsWith("plugin-skills"))).toBe(true);
  });
});

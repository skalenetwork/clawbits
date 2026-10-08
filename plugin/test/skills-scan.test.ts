import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_SKILL_MD_BYTES,
  resolveBundledSkillsDir,
  resolveSkillRoots,
  scanSkills,
  writeRoot,
} from "../src/skills/scan.js";

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

  test("hashes the raw SKILL.md bytes and carries the text", async () => {
    const root = path.join(dir, "skills");
    await writeSkill(root, "weather", "name: weather\ndescription: d");
    const raw = "---\nname: weather\ndescription: d\n---\n\nbody\n";

    const { skills } = await scanSkills([root]);
    expect(skills[0]?.skillMd).toEqual({
      hash: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      text: raw,
    });
  });

  test("keeps the hash but drops the text past 64 KiB", async () => {
    const root = path.join(dir, "skills");
    for (const [slug, size] of [["at-cap", MAX_SKILL_MD_BYTES], ["over-cap", MAX_SKILL_MD_BYTES + 1]] as const) {
      await mkdir(path.join(root, slug), { recursive: true });
      await writeFile(path.join(root, slug, "SKILL.md"), "x".repeat(size));
    }

    const { skills } = await scanSkills([root]);
    const bySlug = new Map(skills.map((s) => [s.slug, s.skillMd]));
    expect(bySlug.get("at-cap")?.text).toHaveLength(MAX_SKILL_MD_BYTES);
    expect(bySlug.get("over-cap")?.hash).toStartWith("sha256:");
    expect(bySlug.get("over-cap")?.text).toBeUndefined();
  });

  test("finds skills nested below a root", async () => {
    const root = path.join(dir, "skills");
    await writeSkill(path.join(root, "group"), "nested", "name: nested\ndescription: d");
    const { skills } = await scanSkills([root]);
    expect(skills[0]?.slug).toBe("nested");
  });
});

describe("resolveSkillRoots", () => {
  test("writes to the workspace root, then the state and plugin-skills dirs", () => {
    const roots = resolveSkillRoots("/ws");
    expect(roots[0]).toBe(path.join("/ws", "skills"));
    expect(writeRoot("/ws")).toBe(path.join("/ws", "skills"));
    expect(roots.some((r) => r.endsWith(path.join(".openclaw", "skills")))).toBe(true);
    expect(roots.some((r) => r.endsWith("plugin-skills"))).toBe(true);
  });
});

describe("resolveBundledSkillsDir", () => {
  let override: string | undefined;
  beforeEach(() => {
    override = process.env.OPENCLAW_BUNDLED_SKILLS_DIR;
    delete process.env.OPENCLAW_BUNDLED_SKILLS_DIR;
  });
  afterEach(() => {
    if (override === undefined) delete process.env.OPENCLAW_BUNDLED_SKILLS_DIR;
    else process.env.OPENCLAW_BUNDLED_SKILLS_DIR = override;
  });

  async function install(name = "openclaw", withSkills = true): Promise<string> {
    const root = path.join(dir, "lib", name);
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name }));
    await writeFile(path.join(root, "dist", "index.js"), "");
    if (withSkills) await mkdir(path.join(root, "skills"));
    return root;
  }

  test("climbs to <install>/skills from a bin symlink into the package", async () => {
    const root = await install();
    await mkdir(path.join(dir, "bin"));
    await symlink(path.join(root, "dist", "index.js"), path.join(dir, "bin", "openclaw"));

    expect(await resolveBundledSkillsDir(path.join(dir, "bin", "openclaw"))).toBe(
      await realpath(path.join(root, "skills")),
    );
  });

  test("honours the host's override", async () => {
    const skills = path.join(dir, "elsewhere");
    await mkdir(skills);
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = skills;
    expect(await resolveBundledSkillsDir(path.join(dir, "nowhere.mjs"))).toBe(skills);
  });

  test("is undefined without an openclaw package or its skills dir", async () => {
    const other = await install("not-openclaw");
    expect(await resolveBundledSkillsDir(path.join(other, "dist", "index.js"))).toBeUndefined();
    const bare = await install("openclaw", false);
    expect(await resolveBundledSkillsDir(path.join(bare, "dist", "index.js"))).toBeUndefined();
  });
});

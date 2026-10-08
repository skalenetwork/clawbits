import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClawBitsClient } from "../src/client.js";
import type { DesiredSkill } from "../src/skills/apply.js";
import { MAX_SKILL_MD_BYTES } from "../src/skills/scan.js";
import { type Reported, syncOnce } from "../src/skills/sync.js";

interface WireSkill {
  slug: string;
  content_hash?: string;
  skill_md?: string;
  skill_md_omitted?: string;
}

interface Report {
  skills: WireSkill[];
  bundled?: { slug: string; description?: string }[];
}

let dir: string;
let workspace: string;
let bundledDir: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "skills-sync-"));
  workspace = path.join(dir, "workspace");
  bundledDir = path.join(dir, "bundled");
  await mkdir(bundledDir, { recursive: true });
  saved = {
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_BUNDLED_SKILLS_DIR: process.env.OPENCLAW_BUNDLED_SKILLS_DIR,
  };
  process.env.OPENCLAW_STATE_DIR = path.join(dir, "state");
  process.env.OPENCLAW_BUNDLED_SKILLS_DIR = bundledDir;
});
afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

async function writeSkill(root: string, slug: string, body: string) {
  await mkdir(path.join(root, slug), { recursive: true });
  await writeFile(path.join(root, slug, "SKILL.md"), body);
}

function fakeClient(desired: DesiredSkill[] = []) {
  const reports: Report[] = [];
  let failNext = false;
  const client = {
    request: async (method: string, url: string, opts?: { json?: unknown }) => {
      if (method === "GET" && url.endsWith("/skills/desired")) return { paused: false, skills: desired };
      if (method === "POST" && url.endsWith("/skills/state")) {
        if (failNext) {
          failNext = false;
          throw new Error("server unavailable");
        }
        reports.push(opts?.json as Report);
        return {};
      }
      throw new Error(`unexpected request ${method} ${url}`);
    },
  } as unknown as ClawBitsClient;
  return { client, reports, failOnce: () => (failNext = true) };
}

function options(client: ClawBitsClient) {
  return { client, accountId: "a", abortSignal: new AbortController().signal, workspaceDir: workspace };
}

function skill(report: Report | undefined, slug: string): WireSkill | undefined {
  return report?.skills.find((s) => s.slug === slug);
}

describe("syncOnce report", () => {
  test("sends SKILL.md text once per hash, and again after a failed report", async () => {
    const root = path.join(workspace, "skills");
    await writeSkill(root, "acme", "---\nname: acme\n---\nv1\n");
    const { client, reports, failOnce } = fakeClient();
    const opts = options(client);
    const reported: Reported = { bodies: new Map() };

    await syncOnce(opts, reported);
    const first = skill(reports[0], "acme");
    expect(first?.content_hash).toStartWith("sha256:");
    expect(first?.skill_md).toBe("---\nname: acme\n---\nv1\n");

    await syncOnce(opts, reported);
    const second = skill(reports[1], "acme");
    expect(second?.content_hash).toBe(first?.content_hash);
    expect(second && "skill_md" in second).toBe(false);

    // The new text rides a report that fails, so the next one carries it again.
    await writeSkill(root, "acme", "---\nname: acme\n---\nv2\n");
    failOnce();
    await expect(syncOnce(opts, reported)).rejects.toThrow("server unavailable");
    await syncOnce(opts, reported);
    const third = skill(reports[2], "acme");
    expect(third?.content_hash).not.toBe(first?.content_hash);
    expect(third?.skill_md).toContain("v2");

    await syncOnce(opts, reported);
    expect(skill(reports[3], "acme")?.content_hash).toBe(third?.content_hash);
    expect(skill(reports[3], "acme")?.skill_md).toBeUndefined();
  });

  test("resends the text of a skill that left the disk and came back", async () => {
    const root = path.join(workspace, "skills");
    await writeSkill(root, "acme", "same");
    const { client, reports } = fakeClient();
    const opts = options(client);
    const reported: Reported = { bodies: new Map() };

    await syncOnce(opts, reported);
    await rm(path.join(root, "acme"), { recursive: true });
    await syncOnce(opts, reported);
    expect(skill(reports[1], "acme")).toBeUndefined();
    await writeSkill(root, "acme", "same");
    await syncOnce(opts, reported);
    expect(skill(reports[2], "acme")?.skill_md).toBe("same");
  });

  test("resends a lower-root copy's text once its managed twin is removed", async () => {
    // The server deletes the tombstone the removal confirms, so the copy left
    // in a lower root comes back as a new row that needs the text again.
    const managed = path.join(workspace, "skills", "acme");
    await writeSkill(path.join(workspace, "skills"), "acme", "managed");
    await mkdir(path.join(managed, ".clawbits"));
    await writeFile(
      path.join(managed, ".clawbits", "origin.json"),
      JSON.stringify({ version: 1, installId: "install-1", slug: "acme", contentHash: "h" }),
    );
    await writeSkill(path.join(dir, "state", "skills"), "acme", "own copy");
    const desired: DesiredSkill[] = [];
    const { client, reports } = fakeClient(desired);
    const opts = options(client);
    const reported: Reported = { bodies: new Map() };

    await syncOnce(opts, reported);
    desired.push({
      install_id: "install-1",
      slug: "acme",
      intent: "absent",
      desired_generation: 2,
      version_id: null,
      content_hash: null,
    });
    await syncOnce(opts, reported);
    expect(skill(reports[1], "acme")?.skill_md).toBe("own copy");

    desired.length = 0;
    await syncOnce(opts, reported);
    expect(skill(reports[2], "acme")?.skill_md).toBe("own copy");
  });

  test("sends only the hash and a reason for an oversize SKILL.md", async () => {
    await writeSkill(path.join(workspace, "skills"), "huge", "x".repeat(MAX_SKILL_MD_BYTES + 1));
    const { client, reports } = fakeClient();

    await syncOnce(options(client), { bodies: new Map() });
    const huge = skill(reports[0], "huge");
    expect(huge?.content_hash).toStartWith("sha256:");
    expect(huge?.skill_md).toBeUndefined();
    expect(huge?.skill_md_omitted).toBe("too_large");
  });

  test("sends the bundled set on the first good report and then only on change", async () => {
    await writeSkill(bundledDir, "weather", '---\nname: weather\ndescription: "Get the weather."\n---\n');
    const { client, reports, failOnce } = fakeClient();
    const opts = options(client);
    const reported: Reported = { bodies: new Map() };

    failOnce();
    await expect(syncOnce(opts, reported)).rejects.toThrow();
    await syncOnce(opts, reported);
    expect(reports[0]?.bundled).toEqual([{ slug: "weather", description: "Get the weather." }]);
    // Bundled skills stay out of the mirrored list.
    expect(skill(reports[0], "weather")).toBeUndefined();

    await syncOnce(opts, reported);
    expect(reports[1]?.bundled).toBeUndefined();

    await writeSkill(bundledDir, "github", "---\nname: github\n---\n");
    await syncOnce(opts, reported);
    expect(reports[2]?.bundled?.map((s) => s.slug).sort()).toEqual(["github", "weather"]);
  });

  test("leaves bundled out when the install dir cannot be found", async () => {
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = path.join(dir, "missing");
    const { client, reports } = fakeClient();

    await syncOnce(options(client), { bodies: new Map() });
    expect(reports[0] && "bundled" in reports[0]).toBe(false);
  });
});

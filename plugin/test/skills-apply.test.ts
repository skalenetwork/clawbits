import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DesiredSkill, applyDesired, applyOne, readMarker } from "../src/skills/apply.js";

let root: string;
let fetched: string[];

const deps = {
  fetchVersion: (versionId: string) => {
    fetched.push(versionId);
    return Promise.resolve({
      files: [
        { path: "SKILL.md", content: `---\nname: x\n---\nbody ${versionId}\n` },
        { path: "references/a.md", content: "ref" },
      ],
    });
  },
};

function present(over: Partial<DesiredSkill> = {}): DesiredSkill {
  return {
    install_id: "install-1",
    slug: "acme",
    intent: "present",
    desired_generation: 7,
    version_id: "v1",
    content_hash: "hash-1",
    ...over,
  };
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "skills-apply-"));
  fetched = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("install", () => {
  test("writes the files and a marker carrying the content hash", async () => {
    const r = await applyOne(root, present(), deps);
    expect(r?.status).toBe("applied");
    expect(r?.observed_generation).toBe(7);

    expect(await readFile(path.join(root, "acme", "SKILL.md"), "utf-8")).toContain("body v1");
    expect(await readFile(path.join(root, "acme", "references", "a.md"), "utf-8")).toBe("ref");
    const marker = await readMarker(path.join(root, "acme"));
    expect(marker?.contentHash).toBe("hash-1");
    expect(marker?.installId).toBe("install-1");
  });

  test("the drift gate: an unchanged hash writes nothing and fetches nothing", async () => {
    await applyOne(root, present(), deps);
    expect(fetched).toEqual(["v1"]);

    const again = await applyOne(root, present(), deps);
    expect(again).toBeNull();
    // No refetch — this is what stops the watcher retriggering every pass.
    expect(fetched).toEqual(["v1"]);
  });

  test("a changed hash rewrites and drops files no longer in the version", async () => {
    await applyOne(root, present(), deps);
    const r = await applyOne(root, present({ version_id: "v2", content_hash: "hash-2" }), {
      fetchVersion: () =>
        Promise.resolve({ files: [{ path: "SKILL.md", content: "new" }] }),
    });
    expect(r?.status).toBe("applied");
    expect(await readFile(path.join(root, "acme", "SKILL.md"), "utf-8")).toBe("new");
    // The stale reference file is gone: the directory is replaced, not merged.
    expect(await exists(path.join(root, "acme", "references", "a.md"))).toBe(false);
  });

  test("refuses to overwrite a directory it does not own", async () => {
    await mkdir(path.join(root, "acme"), { recursive: true });
    await writeFile(path.join(root, "acme", "SKILL.md"), "hand written");

    const r = await applyOne(root, present(), deps);
    expect(r?.status).toBe("failed");
    expect(await readFile(path.join(root, "acme", "SKILL.md"), "utf-8")).toBe("hand written");
  });

  test("rejects a file path escaping the skill directory", async () => {
    const r = await applyOne(root, present(), {
      fetchVersion: () =>
        Promise.resolve({ files: [{ path: "../../escape.md", content: "x" }] }),
    });
    expect(r?.status).toBe("failed");
    expect(await exists(path.join(root, "..", "escape.md"))).toBe(false);
  });

  test("fails honestly when there is no published version", async () => {
    const r = await applyOne(root, present({ version_id: null, content_hash: null }), deps);
    expect(r?.status).toBe("failed");
    expect(r?.error).toContain("no published version");
  });
});

describe("removal", () => {
  test("deletes a skill it owns and reports removed", async () => {
    await applyOne(root, present(), deps);
    const r = await applyOne(root, present({ intent: "absent" }), deps);
    expect(r?.status).toBe("removed");
    expect(await exists(path.join(root, "acme"))).toBe(false);
  });

  test("an already-absent skill reports removed, not failed", async () => {
    const r = await applyOne(root, present({ intent: "absent" }), deps);
    expect(r?.status).toBe("removed");
  });

  test("never deletes a directory it does not own", async () => {
    await mkdir(path.join(root, "acme"), { recursive: true });
    await writeFile(path.join(root, "acme", "SKILL.md"), "user's own");

    const r = await applyOne(root, present({ intent: "absent" }), deps);
    expect(r?.status).toBe("failed");
    expect(await exists(path.join(root, "acme", "SKILL.md"))).toBe(true);
  });
});

describe("applyDesired", () => {
  test("removals run before installs, so a freed slug can be retaken", async () => {
    await applyOne(root, present({ slug: "shared" }), deps);
    const results = await applyDesired(
      root,
      [
        present({ install_id: "install-2", slug: "shared", content_hash: "hash-2", version_id: "v2" }),
        present({ install_id: "install-1", slug: "shared", intent: "absent" }),
      ],
      deps,
    );
    expect(results.map((r) => r.status)).toEqual(["removed", "applied"]);
    expect((await readMarker(path.join(root, "shared")))?.installId).toBe("install-2");
  });

  test("cleans up its staging directory", async () => {
    await applyDesired(root, [present()], deps);
    expect(await exists(path.join(root, ".clawbits-staging"))).toBe(false);
  });

  test("one failure does not stop the rest", async () => {
    const results = await applyDesired(
      root,
      [present({ install_id: "a", slug: "ok" }), present({ install_id: "b", slug: "bad", version_id: null, content_hash: null })],
      deps,
    );
    expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.status === "failed")).toHaveLength(1);
  });
});

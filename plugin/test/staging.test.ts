import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

function allFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(current)) {
    const path = join(current, entry);
    if (statSync(path).isDirectory()) files.push(...allFiles(root, path));
    else files.push(relative(root, path));
  }
  return files.sort();
}

function stage(script: string, target: string, ...flags: string[]): void {
  execFileSync(process.execPath, [join(pluginRoot, script), target, ...flags], {
    cwd: pluginRoot,
    stdio: "pipe",
  });
}

describe("standalone package staging", () => {
  it("builds disjoint channel and companion closures", { timeout: 30_000 }, () => {
    const temp = mkdtempSync(join(tmpdir(), "clawbits-stage-"));
    try {
      execFileSync("bun", ["run", "build"], { cwd: pluginRoot, stdio: "pipe" });
      const channel = join(temp, "channel");
      const tools = join(temp, "tools");
      stage("stage-channel.mjs", channel);
      stage("stage-tools.mjs", tools);
      const channelFiles = allFiles(channel);
      const toolsFiles = allFiles(tools);

      assert.ok(channelFiles.includes("dist/index.js"));
      assert.ok(channelFiles.includes("openclaw.plugin.json"));
      assert.ok(!channelFiles.some((path) => path.startsWith("src/")));
      assert.ok(!channelFiles.some((path) => path.startsWith("skills/")));
      for (const moved of [
        "dist/tools-entry.js",
        "dist/companion-services.js",
        "dist/automations/reconcile.js",
        "dist/email-poller.js",
        "dist/usage/reporter.js",
        "dist/skills/sync.js",
      ]) {
        assert.ok(!channelFiles.includes(moved), `${moved} excluded from channel`);
      }

      assert.ok(toolsFiles.includes("dist/tools-entry.js"));
      assert.ok(toolsFiles.includes("dist/companion-services.js"));
      assert.ok(toolsFiles.includes("dist/automations/reconcile.js"));
      assert.ok(toolsFiles.includes("dist/email-poller.js"));
      assert.ok(toolsFiles.includes("dist/usage/reporter.js"));
      assert.ok(toolsFiles.includes("dist/skills/sync.js"));
      assert.ok(toolsFiles.some((path) => path.startsWith("skills/")));
      assert.ok(!toolsFiles.some((path) => path.startsWith("src/")));
      for (const channelOnly of [
        "dist/index.js",
        "dist/plugin.js",
        "dist/gateway-adapter.js",
        "dist/inbound-poller.js",
        "dist/channel-actions.js",
        "dist/cli.js",
      ]) {
        assert.ok(!toolsFiles.includes(channelOnly), `${channelOnly} excluded from companion`);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("vendors runtime dependencies only when asked", { timeout: 30_000 }, () => {
    // OpenClaw installs a DIRECTORY by copying it — no dependency step ever
    // runs (managed npm/ClawHub sources are the ones that get `npm install`,
    // src/plugins/install-managed-npm.ts). companion-tools.ts imports `typebox`
    // at module scope, so an unvendored companion installed from a path loads
    // with `status: error, missing typebox` while the channel looks healthy.
    // Published artifacts must NOT vendor, or npm resolution is bypassed.
    const temp = mkdtempSync(join(tmpdir(), "clawbits-vendor-"));
    try {
      execFileSync("bun", ["run", "build"], { cwd: pluginRoot, stdio: "pipe" });

      const plain = join(temp, "tools-plain");
      stage("stage-tools.mjs", plain);
      assert.ok(
        !allFiles(plain).some((path) => path.startsWith("node_modules/")),
        "default staging leaves dependency resolution to npm",
      );

      const vendored = join(temp, "tools-vendored");
      stage("stage-tools.mjs", vendored, "--vendor-deps");
      assert.ok(
        allFiles(vendored).some((path) => path.startsWith("node_modules/typebox/")),
        "--vendor-deps makes a path install self-contained",
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

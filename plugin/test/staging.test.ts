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

function stage(script: string, target: string): void {
  execFileSync(process.execPath, [join(pluginRoot, script), target], {
    cwd: pluginRoot,
    stdio: "pipe",
  });
}

describe("standalone package staging", () => {
  it("builds disjoint channel and companion closures", () => {
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
});

#!/usr/bin/env node
// Vendors the real OpenClaw SDK type declarations into .sdk/ so the plugin
// typechecks against the host's own types instead of hand-written stubs.
//
// Pinned to openclaw.build.openclawVersion, which makes that pin load-bearing:
// bumping it is what moves the typecheck. Only *.d.ts and package.json are
// kept (13 MB), and openclaw is deliberately NOT a devDependency: its runtime
// pulls playwright-core, koffi and ~50 more packages for no benefit here,
// because skipLibCheck means tsc never follows the SDK's own imports.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const sdk = join(root, ".sdk");
const dest = join(sdk, "openclaw");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).openclaw.build.openclawVersion;
const stamp = join(sdk, "version");

if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) {
  process.exit(0);
}

rmSync(sdk, { recursive: true, force: true });
mkdirSync(sdk, { recursive: true });

const tgz = execFileSync("npm", ["pack", `openclaw@${version}`, "--pack-destination", sdk, "--silent"], {
  encoding: "utf8",
}).trim();
execFileSync("tar", ["-xzf", join(sdk, tgz), "-C", sdk]);
rmSync(join(sdk, tgz));
renameSync(join(sdk, "package"), dest);

async function prune(dir) {
  let kept = 0;
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) {
      kept += await prune(path);
      continue;
    }
    if (name.endsWith(".d.ts") || path === join(dest, "package.json")) kept += 1;
    else await unlink(path);
  }
  if (kept === 0) rmSync(dir, { recursive: true, force: true });
  return kept;
}

const kept = await prune(dest);
writeFileSync(stamp, `${version}\n`);
console.log(`openclaw@${version}: ${kept} .d.ts vendored into plugin/.sdk`);

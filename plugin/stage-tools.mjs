#!/usr/bin/env node

import { stageArtifact } from "./stage-artifact.mjs";

// `--vendor-deps` copies the package's runtime dependencies into the staged
// artifact. Pass it when the artifact will be installed from a PATH (the reef
// local image stages, update-from-source.sh, refresh.sh): OpenClaw's directory
// install is a plain copy with no dependency step, so `typebox` — imported at
// module scope by companion-tools.ts — would be missing and the tools plugin
// would load with `status: error`. Do NOT pass it for a published artifact:
// managed npm/ClawHub installs run `npm install` and must resolve normally.
const args = process.argv.slice(2);
const vendorDependencies = args.includes("--vendor-deps");
const targetArg = args.find((arg) => !arg.startsWith("--"));

try {
  stageArtifact({
    targetArg,
    entry: "tools-entry.js",
    packageFile: "package.tools.json",
    manifestFile: "openclaw.tools.plugin.json",
    readmeFile: "README.tools.md",
    extraDirectories: ["skills"],
    label: "tools",
    vendorDependencies,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

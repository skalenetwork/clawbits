#!/usr/bin/env node

import { stageArtifact } from "./stage-artifact.mjs";

try {
  stageArtifact({
    targetArg: process.argv[2],
    entry: "tools-entry.js",
    packageFile: "package.tools.json",
    manifestFile: "openclaw.tools.plugin.json",
    readmeFile: "README.tools.md",
    extraDirectories: ["skills"],
    label: "tools",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

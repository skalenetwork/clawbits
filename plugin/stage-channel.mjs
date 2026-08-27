#!/usr/bin/env node

import { stageArtifact } from "./stage-artifact.mjs";

try {
  stageArtifact({
    targetArg: process.argv[2],
    entry: "index.js",
    packageFile: "package.json",
    manifestFile: "openclaw.plugin.json",
    readmeFile: "README.md",
    extraDirectories: ["docs"],
    extraFiles: ["clawbits.config.example.json"],
    label: "channel",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

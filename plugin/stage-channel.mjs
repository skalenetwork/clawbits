#!/usr/bin/env node

import { stageArtifact } from "./stage-artifact.mjs";

// Accepted for symmetry with stage-tools.mjs so callers can pass the same flag
// to both. The channel package declares no runtime dependencies, so this is a
// no-op today; it stays wired so adding one cannot silently break path installs.
const args = process.argv.slice(2);
const vendorDependencies = args.includes("--vendor-deps");
const targetArg = args.find((arg) => !arg.startsWith("--"));

try {
  stageArtifact({
    targetArg,
    entry: "index.js",
    packageFile: "package.json",
    manifestFile: "openclaw.plugin.json",
    readmeFile: "README.md",
    extraDirectories: ["docs"],
    extraFiles: ["clawbits.config.example.json"],
    label: "channel",
    vendorDependencies,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

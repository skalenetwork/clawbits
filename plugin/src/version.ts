// Single source of truth for the plugin version.
//
// We resolve it at runtime from ``package.json`` (one directory above
// ``src`` in dev, one above ``dist`` in the published package) so the
// constant cannot drift from the manifest. The version rides every
// request to the Clawbits API as ``X-Clawbits-Plugin-Version`` so the
// server can compare against its own minimum and either succeed,
// short-circuit with 426, or surface an upgrade hint via the
// healthcheck.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function resolvePluginVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf-8")) as {
      version?: unknown;
    };
    if (typeof raw.version === "string" && raw.version.length > 0) {
      return raw.version;
    }
  } catch {
    // fall through to the safe default
  }
  return "0.0.0";
}

export const PLUGIN_VERSION: string = resolvePluginVersion();

export const PLUGIN_VERSION_HEADER = "X-Clawbits-Plugin-Version";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { CHANNEL_ID, DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { logInfo } from "./file-logger.js";

/** Deep-clone helper that works with or without structuredClone. */
function cloneCfg(cfg: OpenClawConfig): OpenClawConfig {
  if (typeof structuredClone === "function") {
    return structuredClone(cfg);
  }
  return JSON.parse(JSON.stringify(cfg)) as OpenClawConfig;
}

/** Read the clawbits channel section, creating intermediate objects. */
function ensureSection(cfg: OpenClawConfig): Record<string, unknown> {
  const mutable = cfg as OpenClawConfig & { channels?: Record<string, unknown> };
  mutable.channels ??= {};
  const existing = mutable.channels[CHANNEL_ID];
  if (!existing || typeof existing !== "object") {
    mutable.channels[CHANNEL_ID] = {};
  }
  return mutable.channels[CHANNEL_ID] as Record<string, unknown>;
}

/**
 * Write the supplied per-account fields into
 * `channels.clawbits.accounts.<accountId>.*`. For the conventional
 * `default` account we also mirror onto the top-level section so a
 * single-account setup stays flat (matching built-in channel plugins).
 */
export function writeAccountFields(
  cfg: OpenClawConfig,
  accountId: string,
  fields: Record<string, unknown>,
): OpenClawConfig {
  const next = cloneCfg(cfg);
  const section = ensureSection(next);

  if (accountId === DEFAULT_ACCOUNT_ID) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      if (v === null) {
        delete section[k];
        continue;
      }
      section[k] = v;
    }
    return next;
  }

  const accounts =
    section["accounts"] && typeof section["accounts"] === "object"
      ? (section["accounts"] as Record<string, Record<string, unknown>>)
      : {};
  const current =
    accounts[accountId] && typeof accounts[accountId] === "object"
      ? { ...accounts[accountId] }
      : {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v === null) {
      delete current[k];
      continue;
    }
    current[k] = v;
  }
  accounts[accountId] = current;
  section["accounts"] = accounts;
  return next;
}

/**
 * Turn on the agent's browser tooling (`browser.enabled: true`) as a setup
 * default. ``browser`` is a top-level agent setting rather than a Clawbits
 * channel field, but the plugin is installed non-interactively (no setup
 * wizard to prompt), so we opt new installs into browser use here.
 *
 * Two properties keep this audit-defensible despite being a default-on global
 * capability:
 *   - **Overridable**: the flag is only filled in when currently unset, so an
 *     explicit operator choice (including ``false``) is preserved. To opt out,
 *     pre-set ``browser.enabled: false`` before/at install.
 *   - **Logged**: every time the default flips the flag on, it is recorded to
 *     the plugin log so there is a consent/audit trail even on a silent,
 *     automated install.
 */
export function enableBrowserByDefault(cfg: OpenClawConfig): OpenClawConfig {
  const mutable = cfg as OpenClawConfig & { browser?: Record<string, unknown> };
  const existing = mutable.browser;
  if (existing && typeof existing === "object" && "enabled" in existing) {
    return cfg;
  }
  const next = cloneCfg(cfg);
  const nextMutable = next as OpenClawConfig & { browser?: Record<string, unknown> };
  const browser =
    nextMutable.browser && typeof nextMutable.browser === "object"
      ? nextMutable.browser
      : {};
  browser["enabled"] = true;
  nextMutable.browser = browser;
  logInfo(
    undefined,
    "Clawbits setup: enabled browser automation by default (browser.enabled=true). " +
      "Pre-set browser.enabled=false to opt out.",
  );
  return next;
}

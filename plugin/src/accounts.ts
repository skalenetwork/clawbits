import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { DEFAULT_EMAIL_POLL_MS, MIN_EMAIL_POLL_MS } from "./email-constants.js";
import type {
  ClawBitsAccountConfig,
  ClawBitsChannelSection,
  ResolvedClawBitsAccount,
} from "./types.js";

export const CHANNEL_ID = "clawbits" as const;
export const DEFAULT_ACCOUNT_ID = "default" as const;
export const DEFAULT_ENDPOINT = "https://clawbits.ai" as const;

/** Read `cfg.channels.clawbits` tolerantly; missing/wrong shape => undefined. */
function readChannelSection(cfg: OpenClawConfig): ClawBitsChannelSection | undefined {
  const channels = cfg?.channels;
  if (!channels || typeof channels !== "object") return undefined;
  const section = (channels as Record<string, unknown>)[CHANNEL_ID];
  if (!section || typeof section !== "object") return undefined;
  return section as ClawBitsChannelSection;
}

function normalizeAccountId(raw?: string | null): string {
  if (typeof raw !== "string") return DEFAULT_ACCOUNT_ID;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : DEFAULT_ACCOUNT_ID;
}

/**
 * List the account ids declared under `channels.clawbits.accounts.*`, plus
 * `default` whenever the top-level clawbits section carries per-account
 * fields directly (single-account setup). Always returns at least one id so
 * the wizard has something to fall back to.
 */
export function listClawBitsAccountIds(cfg: OpenClawConfig): string[] {
  const section = readChannelSection(cfg);
  const ids = new Set<string>();
  const accounts = section?.accounts;
  if (accounts && typeof accounts === "object") {
    for (const id of Object.keys(accounts)) {
      if (id.trim()) ids.add(id);
    }
  }
  // Treat the top-level section itself as the "default" account whenever
  // any of the clawbits-specific fields are present on it.
  if (section) {
    const hasInlineAccount =
      section.endpoint !== undefined ||
      section.orgId !== undefined ||
      (section as Record<string, unknown>)["org_id"] !== undefined ||
      section.ownerEmail !== undefined ||
      section.agentId !== undefined ||
      section.apiKey !== undefined ||
      section.channelId !== undefined ||
      section.interAgentMode !== undefined;
    if (hasInlineAccount) ids.add(DEFAULT_ACCOUNT_ID);
  }
  if (ids.size === 0) ids.add(DEFAULT_ACCOUNT_ID);
  return [...ids];
}

export function resolveDefaultClawBitsAccountId(cfg: OpenClawConfig): string {
  const section = readChannelSection(cfg);
  const declared = section?.defaultAccount;
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  const ids = listClawBitsAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Build the effective per-account config by layering:
 *  1. top-level `channels.clawbits.*` (single-account convenience), then
 *  2. `channels.clawbits.accounts.<accountId>.*` (explicit override).
 *
 * Keys that do not belong on a per-account slice (`accounts`,
 * `defaultAccount`) are dropped from the merge base.
 */
function mergeAccountConfig(
  section: ClawBitsChannelSection | undefined,
  accountId: string,
): ClawBitsAccountConfig {
  const base: ClawBitsAccountConfig = {};
  if (section) {
    for (const [k, v] of Object.entries(section)) {
      if (k === "accounts" || k === "defaultAccount") continue;
      (base as Record<string, unknown>)[k] = v;
    }
  }
  const override = section?.accounts?.[accountId];
  if (override && typeof override === "object") {
    for (const [k, v] of Object.entries(override)) {
      if (v !== undefined) (base as Record<string, unknown>)[k] = v;
    }
  }
  return base;
}

export function resolveClawBitsAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedClawBitsAccount {
  const section = readChannelSection(params.cfg);
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeAccountConfig(section, accountId);

  const baseEnabled = section?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  const endpoint =
    (typeof merged.endpoint === "string" && merged.endpoint.trim()) || DEFAULT_ENDPOINT;
  const orgId =
    (typeof merged.orgId === "string" && merged.orgId.trim()) ||
    (typeof (merged as Record<string, unknown>)["org_id"] === "string" &&
      ((merged as Record<string, unknown>)["org_id"] as string).trim()) ||
    undefined;

  const knownAnswers: Record<string, string> = {};
  if (merged.knownAnswers && typeof merged.knownAnswers === "object") {
    for (const [k, v] of Object.entries(merged.knownAnswers)) {
      if (typeof v === "string") knownAnswers[k] = v;
    }
  }

  // Optional inbound sender allowlist. Empty / missing means allow everyone.
  // Strings with `human:` / `agent:` prefixes are exact. Bare strings are
  // treated as convenient aliases for either sender kind; numeric entries are
  // legacy human ids and alias `human:<id>`.
  const allowFrom = new Set<string>();
  const rawAllowFrom = (merged as Record<string, unknown>)["allowFrom"];
  if (Array.isArray(rawAllowFrom)) {
    for (const item of rawAllowFrom) {
      if (typeof item === "string") {
        const value = item.trim();
        if (!value) continue;
        allowFrom.add(value);
        if (!value.includes(":")) {
          allowFrom.add(`human:${value}`);
          allowFrom.add(`agent:${value}`);
        }
      } else if (typeof item === "number" && Number.isFinite(item)) {
        const value = String(item);
        allowFrom.add(value);
        allowFrom.add(`human:${value}`);
      }
    }
  }

  const configured = Boolean(
    merged.agentId && merged.apiKey && merged.channelId && (orgId || merged.ownerEmail),
  );

  const rawInterAgentMode =
    (merged as Record<string, unknown>)["interAgentMode"] ??
    (merged as Record<string, unknown>)["inter_agent_mode_enabled"];
  const interAgentMode = rawInterAgentMode === true;

  const DEFAULT_INTER_AGENT_MESSAGE_LIMIT = 10;
  const MAX_INTER_AGENT_MESSAGE_LIMIT = 50;
  const rawInterAgentMessageLimit =
    (merged as Record<string, unknown>)["interAgentMessageLimit"] ??
    (merged as Record<string, unknown>)["inter_agent_message_limit"];
  const interAgentMessageLimit =
    typeof rawInterAgentMessageLimit === "number" &&
    Number.isFinite(rawInterAgentMessageLimit) &&
    rawInterAgentMessageLimit >= 1
      ? Math.min(MAX_INTER_AGENT_MESSAGE_LIMIT, Math.floor(rawInterAgentMessageLimit))
      : DEFAULT_INTER_AGENT_MESSAGE_LIMIT;

  // Default on. Only an explicit ``false`` disables — undefined / non-bool
  // values keep the new behavior.
  const groupChannelShimmer = merged.groupChannelShimmer !== false;

  // Live-activity lanes (LIVE_AGENT_ACTIVITY_PLAN.md): both default on,
  // explicit ``false`` is the per-account kill switch.
  const streaming = merged.streaming !== false;
  const liveActivity = merged.liveActivity !== false;

  // How much pre-tag channel history to feed the agent. Default 100; a
  // missing / non-finite / negative value falls back to the default, while
  // an explicit 0 disables. Floored to an integer so a fractional config
  // value can't slip through to the slice bound.
  const DEFAULT_CONTEXT_BACKLOG = 100;
  const rawBacklog = (merged as Record<string, unknown>)["channelContextBacklog"];
  const channelContextBacklog =
    typeof rawBacklog === "number" && Number.isFinite(rawBacklog) && rawBacklog >= 0
      ? Math.floor(rawBacklog)
      : DEFAULT_CONTEXT_BACKLOG;

  // Liveness ping cadence (config is in seconds; resolved to ms here). Default
  // 10 min, floored at 60s so a misconfig can't hammer the endpoint. An
  // explicit ``enabled: false`` or ``every: 0`` disables the pinger (-> 0).
  const DEFAULT_ALIVE_SECONDS = 600;
  const MIN_ALIVE_SECONDS = 60;
  const aliveCfg =
    merged.alive && typeof merged.alive === "object" ? merged.alive : {};
  let alivePingMs: number;
  if (aliveCfg.enabled === false || aliveCfg.every === 0) {
    alivePingMs = 0;
  } else {
    const everySec =
      typeof aliveCfg.every === "number" &&
      Number.isFinite(aliveCfg.every) &&
      aliveCfg.every > 0
        ? aliveCfg.every
        : DEFAULT_ALIVE_SECONDS;
    alivePingMs = Math.max(MIN_ALIVE_SECONDS, Math.floor(everySec)) * 1000;
  }

  // Email integration. Default on; only an explicit ``false`` disables. Note
  // this means existing deployments begin polling on upgrade — that is
  // intentional (zero-config mailbox UX) and safe: the poller self-disables on
  // a 503 "email not configured" from the server (see `runEmailPoller`). The
  // poll cadence defaults to 60s and is floored at 30s so a misconfig can't
  // hammer the mailbox endpoints.
  const emailEnabled = merged.emailEnabled !== false;
  const rawEmailPoll = (merged as Record<string, unknown>)["emailPollIntervalMs"];
  const emailPollIntervalMs =
    typeof rawEmailPoll === "number" && Number.isFinite(rawEmailPoll) && rawEmailPoll > 0
      ? Math.max(MIN_EMAIL_POLL_MS, Math.floor(rawEmailPoll))
      : DEFAULT_EMAIL_POLL_MS;

  return {
    accountId,
    enabled,
    configured,
    ...(typeof merged.name === "string" ? { name: merged.name } : {}),
    endpoint,
    ...(orgId ? { orgId } : {}),
    ...(typeof merged.ownerEmail === "string" ? { ownerEmail: merged.ownerEmail } : {}),
    ...(typeof merged.agentId === "string" ? { agentId: merged.agentId } : {}),
    ...(typeof merged.apiKey === "string" ? { apiKey: merged.apiKey } : {}),
    ...(typeof merged.channelId === "string" ? { channelId: merged.channelId } : {}),
    knownAnswers,
    allowFrom: [...allowFrom],
    interAgentMode,
    interAgentMessageLimit,
    groupChannelShimmer,
    channelContextBacklog,
    alivePingMs,
    emailEnabled,
    emailPollIntervalMs,
    streaming,
    liveActivity,
    config: merged,
  };
}

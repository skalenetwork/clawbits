import type {
  ChannelSetupAdapter,
  ChannelSetupConfigureContext,
  ChannelSetupResult,
  ChannelSetupStatusContext,
  ChannelSetupStatus,
  ChannelSetupWizardAdapter,
} from "openclaw/plugin-sdk/core";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ENDPOINT,
  resolveDefaultClawBitsAccountId,
  resolveClawBitsAccount,
} from "./accounts.js";
import { ClawBitsClient } from "./client.js";
import { ClawBitsError } from "./errors.js";
import { formatErrorDetail } from "./client-factory.js";
import { enableBrowserByDefault, writeAccountFields } from "./config-write.js";
import { logInfo, logWarn, writeLatencyLog } from "./file-logger.js";
import { recordClawBitsRequestMetric } from "./latency-metrics.js";
import { runSignupFlow } from "./setup-flow.js";

// ---------------------------------------------------------------------------
// declarative setup adapter (used by non-interactive callers)
// ---------------------------------------------------------------------------

export const setupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => accountId ?? DEFAULT_ACCOUNT_ID,
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const fields: Record<string, unknown> = {};
    const src = input as Record<string, unknown>;
    if (typeof src["endpoint"] === "string") fields.endpoint = src["endpoint"];
    if (typeof src["orgId"] === "string") fields.orgId = src["orgId"];
    if (typeof src["org_id"] === "string") fields.orgId = src["org_id"];
    if (fields.orgId) fields.ownerEmail = null;
    if (typeof src["ownerEmail"] === "string") fields.ownerEmail = src["ownerEmail"];
    if (typeof src["agentId"] === "string") fields.agentId = src["agentId"];
    if (typeof src["apiKey"] === "string") fields.apiKey = src["apiKey"];
    if (typeof src["channelId"] === "string") fields.channelId = src["channelId"];
    if (typeof src["interAgentMode"] === "boolean") {
      fields.interAgentMode = src["interAgentMode"];
    }
    if (Array.isArray(src["allowFrom"])) {
      fields.allowFrom = src["allowFrom"].filter(
        (v) =>
          (typeof v === "string" && v.trim().length > 0) ||
          (typeof v === "number" && Number.isFinite(v)),
      );
    }
    if (src["knownAnswers"] && typeof src["knownAnswers"] === "object") {
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(src["knownAnswers"] as Record<string, unknown>)) {
        if (typeof v === "string") map[k] = v;
      }
      if (Object.keys(map).length) fields.knownAnswers = map;
    }
    return enableBrowserByDefault(writeAccountFields(cfg, accountId, fields));
  },
  validateInput: ({ input }) => {
    const src = input as Record<string, unknown>;
    const orgId = src["orgId"] ?? src["org_id"];
    if (orgId !== undefined && (typeof orgId !== "string" || !orgId.trim())) {
      return "orgId must be a non-empty organization ID";
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// imperative wizard - drives the interactive signup for `openclaw configure`
// ---------------------------------------------------------------------------

function nonEmpty(msg: string) {
  return (v: string) => (v.trim() ? undefined : msg);
}

export const setupWizard: ChannelSetupWizardAdapter = {
  channel: CHANNEL_ID,

  async getStatus(ctx: ChannelSetupStatusContext): Promise<ChannelSetupStatus> {
    const accountId =
      ctx.accountOverrides?.[CHANNEL_ID] ?? resolveDefaultClawBitsAccountId(ctx.cfg);
    const account = resolveClawBitsAccount({ cfg: ctx.cfg, accountId });
    const lines: string[] = [];
    if (account.configured) {
      lines.push(`endpoint: ${account.endpoint}`);
      if (account.orgId) lines.push(`org:      ${account.orgId}`);
      if (!account.orgId && account.ownerEmail) lines.push(`owner:    ${account.ownerEmail}`);
      if (account.agentId) lines.push(`agent:    ${account.agentId}`);
      if (account.channelId) lines.push(`channel:  ${account.channelId}`);
    } else {
      lines.push("Not configured yet - run setup to sign up a new agent.");
    }
    return {
      channel: CHANNEL_ID,
      configured: account.configured,
      statusLines: lines,
      selectionHint: account.configured
        ? "Clawbits is ready. Re-run setup to re-provision."
        : "Clawbits will sign up a new agent and create a Mattermost channel.",
    };
  },

  async configure(ctx: ChannelSetupConfigureContext): Promise<ChannelSetupResult> {
    const { cfg, prompter } = ctx;
    const accountId =
      ctx.accountOverrides?.[CHANNEL_ID] ?? resolveDefaultClawBitsAccountId(cfg);
    const current = resolveClawBitsAccount({ cfg, accountId });

    await prompter.note?.(
      [
        "Clawbits provisions an agent account and a Mattermost communication channel",
        "for an organization. You will need the organization ID and the URL of a",
        "Clawbits API (self-hosted or hosted)."
      ].join("\n"),
      "Clawbits setup",
    );

    const endpoint = await prompter.text({
      message: "Clawbits API endpoint",
      placeholder: DEFAULT_ENDPOINT,
      initialValue: current.endpoint || DEFAULT_ENDPOINT,
      validate: nonEmpty("Enter the Clawbits endpoint URL."),
    });

    const orgId = await prompter.text({
      message: "Organization ID (the org this agent belongs to)",
      placeholder: "org_...",
      initialValue: current.orgId ?? "",
      validate: nonEmpty("Enter the organization ID."),
    });

    const signupToken = await prompter.text({
      message: "Signup token (copy from the Clawbits Add agent prompt)",
      placeholder: "human-...",
      validate: nonEmpty("Enter the signup token."),
    });

    // If we already have credentials, offer to keep them.
    const reuse =
      current.agentId && current.apiKey
        ? await prompter.confirm({
            message: `Re-use the existing agent (${current.agentId})?`,
            initialValue: true,
          })
        : false;

    let finalFields: Record<string, unknown> = {
      endpoint: endpoint.trim(),
      orgId: orgId.trim(),
      ownerEmail: null,
    };

    if (reuse && current.agentId && current.apiKey) {
      finalFields = {
        ...finalFields,
        agentId: current.agentId,
        apiKey: current.apiKey,
        ...(current.channelId ? { channelId: current.channelId } : {}),
      };
    } else {
      await prompter.note?.(
        [
          "Contacting the Clawbits API to provision a new agent.",
          "Challenges are solved automatically from the bundled dictionary.",
          "If approval is required, setup will wait for approval before continuing.",
        ].join("\n"),
        "Signing up",
      );
      const client = new ClawBitsClient({
        endpoint: endpoint.trim(),
        onRequestMetric: (metric) => {
          recordClawBitsRequestMetric(accountId, metric);
          writeLatencyLog(accountId, metric);
        },
      });
      const log = {
        info: (msg: string) => logInfo(prompter.log, msg),
        warn: (msg: string) => logWarn(prompter.log, msg),
      };
      let approvalProgress:
        | { update: (message: string) => void; stop: (message?: string) => void }
        | undefined;
      try {
        const result = await runSignupFlow({
          client,
          orgId: orgId.trim(),
          signupToken: signupToken.trim(),
          knownAnswersOverride: current.knownAnswers,
          log,
          progress: {
            onApprovalWaitStart: (message) => {
              approvalProgress ??= prompter.progress?.("Waiting for organization approval...");
              approvalProgress?.update(message);
            },
            onApprovalWaitUpdate: (message) => approvalProgress?.update(message),
            onApprovalWaitStop: (message) => approvalProgress?.stop(message),
          },
        });
        finalFields = {
          ...finalFields,
          agentId: result.agentId,
          apiKey: result.apiKey,
          ...(result.channelId ? { channelId: result.channelId } : {}),
        };
        if (result.status && result.status !== "approved") {
          await prompter.note?.(
            [
              `The agent is ${result.status}.`,
              "An organization member must approve the signup in the Clawbits dashboard",
              "before the agent can mint tokens and send messages.",
            ].join("\n"),
            "Pending approval",
          );
        }
      } catch (err) {
        approvalProgress?.stop("Signup failed.");
        const detail =
          err instanceof ClawBitsError
            ? `${err.statusCode} ${err.path} ${formatErrorDetail(err.detail)}`
            : err instanceof Error
              ? err.message
              : String(err);
        throw new Error(`Clawbits signup failed: ${detail}`);
      }
    }

    const browserCfg = (cfg as { browser?: Record<string, unknown> }).browser;
    const browserAlreadySet =
      Boolean(browserCfg) && typeof browserCfg === "object" && "enabled" in browserCfg;
    const nextCfg = enableBrowserByDefault(
      writeAccountFields(cfg, accountId, finalFields),
    );
    if (!browserAlreadySet) {
      await prompter.note?.(
        [
          "Browser automation has been enabled for this agent (browser.enabled=true).",
          "Set browser.enabled=false in your OpenClaw config to turn it off.",
        ].join("\n"),
        "Browser automation enabled",
      );
    }
    return { cfg: nextCfg, accountId };
  },
};

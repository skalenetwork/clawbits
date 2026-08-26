import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  listClawBitsAccountIds,
  resolveClawBitsAccount,
  resolveDefaultClawBitsAccountId,
} from "./accounts.js";
import { buildClientForAccount } from "./client-factory.js";
import type { ClawBitsClient } from "./client.js";
import { getAgentInfo } from "./tools/agents.js";
import { emailGet, emailInbox, type EmailDetail } from "./tools/email.js";
import { listChannels, listMembers } from "./tools/mattermost.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export const CLAWBITS_TOOL_NAMES = [
  "clawbits_channels_list",
  "clawbits_channel_members",
  "clawbits_email_inbox",
  "clawbits_email_get",
  "clawbits_agent_info",
] as const;

// Every tool call is bounded so a stalled connection can't pin the tool
// runtime on undici's ~300s header/body default (see RequestOptions.signal in
// client.ts). email_get gets longer: the server inlines attachment payloads
// in the response body.
const TOOL_REQUEST_TIMEOUT_MS = 30_000;
const EMAIL_GET_TIMEOUT_MS = 60_000;

/** The runtime's abort signal (when provided) combined with a hard timeout. */
function toolRequestSignal(
  context: { signal?: AbortSignal },
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
}

function clientForConfig(
  cfg: OpenClawConfig,
  accountId?: string,
  opts?: { requireEmail?: boolean },
): { client: ClawBitsClient; agentId: string } {
  const requestedAccountId = accountId?.trim();
  // An explicit account id must name a configured account. Without this check
  // a typo would silently fall through to the top-level inline account (the
  // merge in resolveClawBitsAccount treats accounts.<id> as an optional
  // override) and read — or mark read — the wrong mailbox.
  if (requestedAccountId) {
    const knownIds = listClawBitsAccountIds(cfg);
    if (!knownIds.includes(requestedAccountId)) {
      throw new Error(
        `Unknown Clawbits account '${requestedAccountId}'. Configured account ids: ${knownIds.join(", ")}.`,
      );
    }
  }
  const resolvedAccountId = requestedAccountId || resolveDefaultClawBitsAccountId(cfg);
  const account = resolveClawBitsAccount({ cfg, accountId: resolvedAccountId });
  if (!account.configured || !account.agentId) {
    throw new Error(
      `Clawbits account '${resolvedAccountId}' is not configured; install and configure the Clawbits channel plugin first.`,
    );
  }
  // Honor the same operator kill switches the channel plugin honors; the
  // tools ride the channel's credentials and must not outlive its gates.
  if (!account.enabled) {
    throw new Error(
      `Clawbits account '${resolvedAccountId}' is disabled (enabled=false in channels.clawbits config).`,
    );
  }
  if (opts?.requireEmail && !account.emailEnabled) {
    throw new Error(
      `Clawbits email integration is disabled for account '${resolvedAccountId}' (emailEnabled=false).`,
    );
  }
  return {
    client: buildClientForAccount(account),
    agentId: account.agentId,
  };
}

/**
 * Replace inline base64 attachment bodies with metadata. The channel path
 * never hands raw bytes to the model either (email-adapter caps and uploads
 * them); a multi-megabyte content_b64 in a tool result would flood the
 * agent's context.
 */
function redactEmailAttachments(detail: EmailDetail): Omit<EmailDetail, "attachments"> & {
  attachments?: Array<{ filename: string; content_type?: string; size?: number }>;
  attachments_note?: string;
} {
  const attachments = detail.attachments;
  if (!attachments?.length) return detail;
  return {
    ...detail,
    attachments: attachments.map((attachment) => ({
      filename: attachment.filename,
      ...(attachment.content_type !== undefined
        ? { content_type: attachment.content_type }
        : {}),
      size:
        typeof attachment.size === "number"
          ? attachment.size
          : Math.floor((attachment.content_b64.length * 3) / 4),
    })),
    attachments_note: "Attachment bodies are omitted from tool output; metadata only.",
  };
}

const accountIdParameter = Type.Optional(
  Type.String({
    description:
      "Clawbits account id from channels.clawbits.accounts. Uses the configured default when omitted.",
    minLength: 1,
  }),
);

export default defineToolPlugin({
  id: "clawbits-tools",
  name: "Clawbits Tools",
  description: "Read Clawbits channels, email, and agent information.",
  tools: (tool) => [
    tool({
      name: CLAWBITS_TOOL_NAMES[0],
      label: "List Clawbits Channels",
      description: "List the Clawbits channels available to this agent.",
      parameters: Type.Object({ accountId: accountIdParameter }),
      optional: true,
      async execute({ accountId }, _config, context) {
        context.signal?.throwIfAborted();
        const { client } = clientForConfig(context.api.config, accountId);
        return listChannels(client, toolRequestSignal(context, TOOL_REQUEST_TIMEOUT_MS));
      },
    }),
    tool({
      name: CLAWBITS_TOOL_NAMES[1],
      label: "List Clawbits Channel Members",
      description: "List members of one Clawbits channel.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Clawbits channel id.", minLength: 1 }),
        accountId: accountIdParameter,
      }),
      optional: true,
      async execute({ channelId, accountId }, _config, context) {
        context.signal?.throwIfAborted();
        const { client } = clientForConfig(context.api.config, accountId);
        return listMembers(
          client,
          channelId,
          toolRequestSignal(context, TOOL_REQUEST_TIMEOUT_MS),
        );
      },
    }),
    tool({
      name: CLAWBITS_TOOL_NAMES[2],
      label: "List Clawbits Email",
      description: "List messages in this agent's Clawbits email inbox.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({ description: "Maximum messages to return. Defaults to 20.", minimum: 1, maximum: 100 }),
        ),
        offset: Type.Optional(
          Type.Integer({ description: "Inbox offset. Defaults to 0.", minimum: 0 }),
        ),
        accountId: accountIdParameter,
      }),
      optional: true,
      async execute({ limit, offset, accountId }, _config, context) {
        context.signal?.throwIfAborted();
        const { client, agentId } = clientForConfig(context.api.config, accountId, {
          requireEmail: true,
        });
        return emailInbox(client, agentId, {
          limit: limit ?? 20,
          offset: offset ?? 0,
          signal: toolRequestSignal(context, TOOL_REQUEST_TIMEOUT_MS),
        });
      },
    }),
    tool({
      name: CLAWBITS_TOOL_NAMES[3],
      label: "Read Clawbits Email",
      description:
        "Read one Clawbits email by UID. Reading it marks it read. Attachment bodies are omitted; only attachment metadata is returned.",
      parameters: Type.Object({
        messageUid: Type.Integer({ description: "Email message UID.", minimum: 1 }),
        accountId: accountIdParameter,
      }),
      optional: true,
      async execute({ messageUid, accountId }, _config, context) {
        context.signal?.throwIfAborted();
        const { client, agentId } = clientForConfig(context.api.config, accountId, {
          requireEmail: true,
        });
        const detail = await emailGet(
          client,
          agentId,
          messageUid,
          toolRequestSignal(context, EMAIL_GET_TIMEOUT_MS),
        );
        return redactEmailAttachments(detail);
      },
    }),
    tool({
      name: CLAWBITS_TOOL_NAMES[4],
      label: "Get Clawbits Agent Information",
      description: "Get this agent's Clawbits profile and organization information.",
      parameters: Type.Object({ accountId: accountIdParameter }),
      optional: true,
      async execute({ accountId }, _config, context) {
        context.signal?.throwIfAborted();
        const { client, agentId } = clientForConfig(context.api.config, accountId);
        return getAgentInfo(
          client,
          agentId,
          toolRequestSignal(context, TOOL_REQUEST_TIMEOUT_MS),
        );
      },
    }),
  ],
});

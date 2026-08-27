import { Type } from "typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  listClawBitsAccountIds,
  resolveClawBitsAccount,
  resolveDefaultClawBitsAccountId,
} from "./accounts.js";
import { resolveKnownAnswers, withChallenge } from "./challenge.js";
import { buildClientForAccount } from "./client-factory.js";
import type { ClawBitsClient } from "./client.js";
import { frameEmailForDm } from "./email-dm-frame.js";
import { logWarn } from "./file-logger.js";
import { getAgentInfo, updateAgentDescription } from "./tools/agents.js";
import {
  emailGet,
  emailInbox,
  emailSend,
  type EmailDetail,
  type EmailSendAttachment,
} from "./tools/email.js";
import { listChannels, listMembers, postToChannel } from "./tools/mattermost.js";

export const CLAWBITS_TOOL_NAMES = [
  "clawbits_channels_list",
  "clawbits_channel_members",
  "clawbits_email_inbox",
  "clawbits_email_get",
  "clawbits_agent_info",
  "clawbits_email_send",
  "clawbits_agent_description_update",
] as const;

const TOOL_REQUEST_TIMEOUT_MS = 30_000;
const EMAIL_GET_TIMEOUT_MS = 60_000;

function toolRequestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function clientForConfig(
  cfg: OpenClawConfig,
  accountId?: string,
  opts?: { requireEmail?: boolean },
): { client: ClawBitsClient; agentId: string; accountId: string } {
  const requestedAccountId = accountId?.trim();
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
    accountId: resolvedAccountId,
  };
}

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

function jsonResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

const accountIdParameter = Type.Optional(
  Type.String({
    description:
      "Clawbits account id from channels.clawbits.accounts. Uses the configured default when omitted.",
    minLength: 1,
  }),
);

const attachmentParameter = Type.Object({
  filename: Type.String({ minLength: 1 }),
  content_b64: Type.String({ minLength: 1 }),
});

export function registerClawbitsTools(api: OpenClawPluginApi): void {
  api.registerTool(
    {
      name: CLAWBITS_TOOL_NAMES[0],
      label: "List Clawbits Channels",
      description: "List the Clawbits channels available to this agent.",
      parameters: Type.Object({ accountId: accountIdParameter }),
      async execute(_toolCallId, { accountId }, signal) {
        signal?.throwIfAborted();
        const { client } = clientForConfig(api.config, accountId);
        return jsonResult(
          await listChannels(client, toolRequestSignal(signal, TOOL_REQUEST_TIMEOUT_MS)),
        );
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: CLAWBITS_TOOL_NAMES[1],
      label: "List Clawbits Channel Members",
      description: "List members of one Clawbits channel.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Clawbits channel id.", minLength: 1 }),
        accountId: accountIdParameter,
      }),
      async execute(_toolCallId, { channelId, accountId }, signal) {
        signal?.throwIfAborted();
        const { client } = clientForConfig(api.config, accountId);
        return jsonResult(
          await listMembers(
            client,
            channelId,
            toolRequestSignal(signal, TOOL_REQUEST_TIMEOUT_MS),
          ),
        );
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: CLAWBITS_TOOL_NAMES[2],
      label: "List Clawbits Email",
      description: "List messages in this agent's Clawbits email inbox.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum messages to return. Defaults to 20.",
            minimum: 1,
            maximum: 100,
          }),
        ),
        offset: Type.Optional(
          Type.Integer({ description: "Inbox offset. Defaults to 0.", minimum: 0 }),
        ),
        accountId: accountIdParameter,
      }),
      async execute(_toolCallId, { limit, offset, accountId }, signal) {
        signal?.throwIfAborted();
        const { client, agentId } = clientForConfig(api.config, accountId, {
          requireEmail: true,
        });
        return jsonResult(
          await emailInbox(client, agentId, {
            limit: limit ?? 20,
            offset: offset ?? 0,
            signal: toolRequestSignal(signal, TOOL_REQUEST_TIMEOUT_MS),
          }),
        );
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: CLAWBITS_TOOL_NAMES[3],
      label: "Read Clawbits Email",
      description:
        "Read one Clawbits email by UID. Reading it marks it read. Attachment bodies are omitted; only attachment metadata is returned.",
      parameters: Type.Object({
        messageUid: Type.Integer({ description: "Email message UID.", minimum: 1 }),
        accountId: accountIdParameter,
      }),
      async execute(_toolCallId, { messageUid, accountId }, signal) {
        signal?.throwIfAborted();
        const { client, agentId } = clientForConfig(api.config, accountId, {
          requireEmail: true,
        });
        const detail = await emailGet(
          client,
          agentId,
          messageUid,
          toolRequestSignal(signal, EMAIL_GET_TIMEOUT_MS),
        );
        return jsonResult(redactEmailAttachments(detail));
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: CLAWBITS_TOOL_NAMES[4],
      label: "Get Clawbits Agent Information",
      description: "Get this agent's Clawbits profile and organization information.",
      parameters: Type.Object({ accountId: accountIdParameter }),
      async execute(_toolCallId, { accountId }, signal) {
        signal?.throwIfAborted();
        const { client, agentId } = clientForConfig(api.config, accountId);
        return jsonResult(
          await getAgentInfo(
            client,
            agentId,
            toolRequestSignal(signal, TOOL_REQUEST_TIMEOUT_MS),
          ),
        );
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: CLAWBITS_TOOL_NAMES[5],
      label: "Send Clawbits Email",
      description:
        "Send an email from this agent to its Clawbits operator. This is a paid, challenge-gated action.",
      parameters: Type.Object({
        subject: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 }),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        attachments: Type.Optional(Type.Array(attachmentParameter)),
        accountId: accountIdParameter,
      }),
      async execute(
        _toolCallId,
        { subject, message, headers, attachments, accountId },
        signal,
      ) {
        signal?.throwIfAborted();
        const normalizedSubject = subject.trim();
        const normalizedMessage = message.trim();
        if (!normalizedSubject || !normalizedMessage) {
          throw new Error("Clawbits email subject and message must not be blank.");
        }
        const { client, agentId, accountId: resolvedAccountId } = clientForConfig(
          api.config,
          accountId,
          { requireEmail: true },
        );
        const account = resolveClawBitsAccount({
          cfg: api.config,
          accountId: resolvedAccountId,
        });
        const answers = resolveKnownAnswers(account.knownAnswers);
        const requestSignal = toolRequestSignal(signal, TOOL_REQUEST_TIMEOUT_MS);
        const sent = await withChallenge(
          client,
          answers,
          (answer) =>
            emailSend(
              client,
              agentId,
              {
                subject: normalizedSubject,
                message: normalizedMessage,
                ...(headers ? { headers } : {}),
                ...(attachments
                  ? { attachments: attachments as EmailSendAttachment[] }
                  : {}),
              },
              answer,
              requestSignal,
            ),
          { signal: requestSignal },
        );
        if (account.channelId) {
          try {
            await withChallenge(
              client,
              answers,
              (answer) =>
                postToChannel(
                  client,
                  account.channelId as string,
                  {
                    message: frameEmailForDm({
                      kind: "sent",
                      subject: normalizedSubject,
                      body: normalizedMessage,
                    }),
                  },
                  answer,
                  requestSignal,
                ),
              { signal: requestSignal },
            );
          } catch (err) {
            logWarn(
              api.logger,
              `[clawbits/${resolvedAccountId}] email-send DM mirror failed: ${String((err as Error)?.message ?? err)}`,
            );
          }
        }
        return jsonResult(sent);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: CLAWBITS_TOOL_NAMES[6],
      label: "Update Clawbits Agent Description",
      description: "Update this agent's public Clawbits profile description.",
      parameters: Type.Object({
        description: Type.String({ minLength: 1, maxLength: 280 }),
        accountId: accountIdParameter,
      }),
      async execute(_toolCallId, { description, accountId }, signal) {
        signal?.throwIfAborted();
        const normalizedDescription = description.trim();
        if (!normalizedDescription) {
          throw new Error("Clawbits agent description must not be blank.");
        }
        const { client, agentId } = clientForConfig(api.config, accountId);
        return jsonResult(
          await updateAgentDescription(
            client,
            agentId,
            normalizedDescription,
            toolRequestSignal(signal, TOOL_REQUEST_TIMEOUT_MS),
          ),
        );
      },
    },
    { optional: true },
  );
}

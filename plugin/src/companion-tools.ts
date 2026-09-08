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
  type EmailSendAttachment,
} from "./tools/email.js";
import {
  getChannelPosts,
  getPostsAround,
  listChannels,
  listMembers,
  postToChannel,
  searchPosts,
  toggleReaction,
} from "./tools/mattermost.js";
import {
  summarizeChannels,
  summarizeEmail,
  summarizePosts,
  summarizeSearch,
} from "./tool-views.js";
import type { ResolvedClawBitsAccount } from "./types.js";

export const CLAWBITS_TOOL_NAMES = [
  "clawbits_channels_list",
  "clawbits_channel_members",
  "clawbits_email_inbox",
  "clawbits_email_get",
  "clawbits_agent_info",
  "clawbits_email_send",
  "clawbits_agent_description_update",
  "clawbits_react",
  "clawbits_search",
  "clawbits_channel_posts",
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
): {
  client: ClawBitsClient;
  account: ResolvedClawBitsAccount;
  agentId: string;
  channelId: string;
} {
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
  if (!account.configured || !account.agentId || !account.channelId) {
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
    account,
    agentId: account.agentId,
    channelId: account.channelId,
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

/** The fields this plugin reads off a post's reaction buckets. The server's
 *  richer shape (counts, human ids) passes through to the model untouched. */
type ReactionBuckets = Array<{ emoji: string; agent_ids?: string[] }>;

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
          summarizeChannels(
            await listChannels(client, toolRequestSignal(signal, TOOL_REQUEST_TIMEOUT_MS)),
          ),
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
        return jsonResult(summarizeEmail(detail));
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
        const { client, account, agentId, channelId } = clientForConfig(api.config, accountId, {
          requireEmail: true,
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
        try {
          await withChallenge(
            client,
            answers,
            (answer) =>
              postToChannel(
                client,
                channelId,
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
            `[clawbits/${account.accountId}] email-send DM mirror failed: ${String((err as Error)?.message ?? err)}`,
          );
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

  api.registerTool(
    {
      name: CLAWBITS_TOOL_NAMES[7],
      label: "React to a Clawbits Post",
      description:
        "Toggle this agent's emoji reaction on a Clawbits post. Use a reaction where it " +
        "says what a message would not be worth sending for: acknowledging a request you " +
        "are picking up, agreeing, marking work done, celebrating someone's news. Pick " +
        "the emoji that fits the meaning, at most one per post, and never in place of an " +
        "answer someone is waiting for. The same emoji a second time removes it. This is " +
        "a paid, challenge-gated action.",
      parameters: Type.Object({
        messageId: Type.String({
          description: "Clawbits post id of the message being reacted to.",
          minLength: 1,
        }),
        emoji: Type.String({ description: "Unicode emoji glyph.", minLength: 1 }),
        remove: Type.Optional(
          Type.Boolean({ description: "Remove this agent's reaction instead of toggling." }),
        ),
        accountId: accountIdParameter,
      }),
      async execute(_toolCallId, { messageId, emoji, remove, accountId }, signal) {
        signal?.throwIfAborted();
        const postId = messageId.trim();
        const glyph = emoji.trim();
        if (!postId || !glyph) {
          throw new Error("Clawbits messageId and emoji must not be blank.");
        }
        const { client, account, agentId } = clientForConfig(api.config, accountId);
        const answers = resolveKnownAnswers(account.knownAnswers);
        const requestSignal = toolRequestSignal(signal, TOOL_REQUEST_TIMEOUT_MS);
        const toggle = async (): Promise<ReactionBuckets> => {
          const post = (await withChallenge(
            client,
            answers,
            (answer) => toggleReaction(client, postId, glyph, answer, requestSignal),
            { signal: requestSignal },
          )) as { reactions?: ReactionBuckets };
          return post.reactions ?? [];
        };
        // The server toggles unconditionally, so whether this agent appears in
        // the emoji's bucket afterwards is the only reliable read of the state.
        const mine = (buckets: ReactionBuckets): boolean =>
          buckets.some((b) => b.emoji === glyph && (b.agent_ids ?? []).includes(agentId));

        let reactions = await toggle();
        if (remove === true && mine(reactions)) reactions = await toggle();
        return jsonResult({
          messageId: postId,
          emoji: glyph,
          state: mine(reactions) ? "added" : "removed",
          reactions,
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: CLAWBITS_TOOL_NAMES[8],
      label: "Search Clawbits Messages",
      description:
        "Full-text search over messages in the Clawbits channels this agent belongs to. " +
        "Use it before answering anything about what was said, decided or shared here: " +
        "the conversation history in your prompt is only a short recent window. Results " +
        "carry the post id, so clawbits_channel_posts can read a hit in context.",
      parameters: Type.Object({
        query: Type.String({ description: "Search text.", minLength: 1 }),
        channelId: Type.Optional(
          Type.String({
            description: "Restrict to one channel id from clawbits_channels_list.",
            minLength: 1,
          }),
        ),
        sort: Type.Optional(
          Type.Union([Type.Literal("recent"), Type.Literal("relevant")], {
            description: "Order hits by recency (default) or match quality.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({ description: "Hits to return, 1-50. Defaults to 25.", minimum: 1, maximum: 50 }),
        ),
        cursor: Type.Optional(
          Type.String({ description: "next_cursor from a previous result, for the next page." }),
        ),
        accountId: accountIdParameter,
      }),
      async execute(_toolCallId, { query, channelId, sort, limit, cursor, accountId }, signal) {
        signal?.throwIfAborted();
        const q = query.trim();
        if (!q) throw new Error("Clawbits search query must not be blank.");
        const { client, channelId: contextChannelId } = clientForConfig(api.config, accountId);
        return jsonResult(
          summarizeSearch(
            await searchPosts(
              client,
              {
                // The server derives the retrieval surface from this channel.
                // A tool has no turn context, so it is always the account's own
                // channel: the widest scope, and still only what this agent may
                // already read (membership is enforced per hit).
                contextChannelId,
                q,
                ...(channelId ? { channelId } : {}),
                ...(sort ? { sort } : {}),
                ...(limit === undefined ? {} : { limit }),
                ...(cursor ? { cursor } : {}),
              },
              toolRequestSignal(signal, TOOL_REQUEST_TIMEOUT_MS),
            ),
          ),
        );
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: CLAWBITS_TOOL_NAMES[9],
      label: "Read Clawbits Channel Posts",
      description:
        "Read messages from a Clawbits channel this agent belongs to: the most recent " +
        "ones, or the window around a post id when aroundPostId is given. Use it to catch " +
        "up on a channel you are not currently answering in, or to read a clawbits_search " +
        "hit in its surrounding conversation.",
      parameters: Type.Object({
        channelId: Type.String({
          description: "Channel id from clawbits_channels_list.",
          minLength: 1,
        }),
        aroundPostId: Type.Optional(
          Type.Integer({
            description: "Centre the window on this post id instead of reading the latest.",
            minimum: 1,
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            description: "Posts to return, 1-50. Defaults to 25.",
            minimum: 1,
            maximum: 50,
          }),
        ),
        accountId: accountIdParameter,
      }),
      async execute(_toolCallId, { channelId, aroundPostId, limit, accountId }, signal) {
        signal?.throwIfAborted();
        const { client } = clientForConfig(api.config, accountId);
        const requestSignal = toolRequestSignal(signal, TOOL_REQUEST_TIMEOUT_MS);
        const count = limit ?? 25;
        return jsonResult(
          summarizePosts(
            aroundPostId === undefined
              ? await getChannelPosts(client, channelId, count, undefined, requestSignal)
              : await getPostsAround(client, channelId, aroundPostId, count, requestSignal),
          ),
        );
      },
    },
    { optional: true },
  );
}

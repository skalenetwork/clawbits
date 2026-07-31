/**
 * ClawBits channel action adapter.
 *
 * Wires the plugin into OpenClaw's shared `message` tool surface so an
 * agent can invoke `react` (and read aggregated `reactions`) on posts in
 * a ClawBits channel, and save its profile description with
 * `update_description`. The text-send path is handled by `outboundAdapter.
 * sendText`; this adapter is purely for the non-send actions.
 *
 * The contract this file targets:
 *   - `ChannelMessageActionAdapter` ({@link openclaw/plugin-sdk/channel-contract})
 *     — the `actions` slot on the channel plugin object
 *   - `describeMessageTool` returns the action menu and any plugin-owned
 *     schema fragments (e.g. the `messageId` field for `react` /
 *     `reactions`)
 *   - `handleAction` reads the agent's tool params and calls the
 *     ClawBits HTTP API via `mmTools.toggleReaction` and friends.
 *
 * Mirror of {@link openclaw/extensions/slack/src/channel-actions.ts}; kept
 * deliberately narrow — only `react` / `reactions` / `update_description`
 * are wired today. `send` remains on `outboundAdapter.sendText`.
 */
import type {
  AgentToolResult,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionDiscoveryContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "openclaw/plugin-sdk/channel-contract";

import { resolveClawBitsAccount } from "./accounts.js";
import { resolveKnownAnswers, withChallenge } from "./challenge.js";
import { ClawBitsClient } from "./client.js";
import { ClawBitsError } from "./errors.js";
import { frameEmailForDm } from "./email-dm-frame.js";
import { logWarn } from "./file-logger.js";
import * as agentTools from "./tools/agents.js";
import * as emailTools from "./tools/email.js";
import type { EmailSendAttachment } from "./tools/email.js";
import * as mmTools from "./tools/mattermost.js";
import type { ResolvedClawBitsAccount } from "./types.js";

// ---------------------------------------------------------------------------
// Local helpers (kept self-contained — the plugin avoids depending on
// `openclaw/plugin-sdk/channel-actions` so it can compile and unit-test
// without the SDK helpers in scope).
// ---------------------------------------------------------------------------

function readStringParam(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = params[key];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof raw === "number") {
    return String(raw);
  }
  return undefined;
}

function readBooleanParam(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const raw = params[key];
  return typeof raw === "boolean" ? raw : undefined;
}

/** Build a ClawBits HTTP client from a resolved account. Mirrors the
 *  helper in `plugin.ts` — duplicated here to keep the action adapter
 *  decoupled from the outbound module. */
function buildClient(account: ResolvedClawBitsAccount): ClawBitsClient {
  if (!account.apiKey) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "ClawBits account has no apiKey configured.",
      path: "/",
    });
  }
  return new ClawBitsClient({
    endpoint: account.endpoint,
    apiKey: account.apiKey,
  });
}

function jsonOk<T extends Record<string, unknown>>(payload: T): AgentToolResult<T> {
  return { ok: true, data: payload };
}

// ---------------------------------------------------------------------------
// Discovery — what the host should advertise on the shared `message` tool.
// ---------------------------------------------------------------------------

/** Action subset this adapter handles end-to-end. `send` is intentionally
 *  not listed — it stays on `outboundAdapter.sendText`. */
const CLAWBITS_ACTIONS = ["react", "reactions", "update_description", "send_email"] as const satisfies readonly ChannelMessageActionName[];

/** Schema fragment for the post-id field used by the reaction actions.
 *  Surfaced through `describeMessageTool` so the model knows the param
 *  name without us having to mutate the global tool schema. */
function buildReactionSchemaFragment(): ChannelMessageToolSchemaContribution {
  return {
    properties: {
      messageId: {
        type: "string",
        description:
          'ClawBits post id (numeric, e.g. "42"). Required for action="react" and action="reactions". Read it from `post_id` on inbound posts.',
      },
      message_id: {
        type: "string",
        description:
          'Alias for messageId. ClawBits post id (numeric). Required for action="react" and action="reactions".',
      },
      emoji: {
        type: "string",
        description:
          'Unicode emoji glyph for action="react". Toggle semantics: the same emoji a second time removes the reaction. Omit (or set `remove: true`) to remove.',
      },
      remove: {
        type: "boolean",
        description:
          'Optional flag for action="react". When true, removes the agent\'s reaction with this emoji instead of toggling.',
      },
    },
    actions: ["react", "reactions"],
  };
}

function buildDescriptionSchemaFragment(): ChannelMessageToolSchemaContribution {
  return {
    properties: {
      description: {
        type: "string",
        description:
          'One short, high-level profile description to save for action="update_description". Max 280 chars; prefer ~120 chars. Do not include private or sensitive specifics.',
      },
    },
    actions: ["update_description"],
  };
}

function buildSendEmailSchemaFragment(): ChannelMessageToolSchemaContribution {
  return {
    properties: {
      subject: {
        type: "string",
        description: 'Subject line for action="send_email". Required.',
      },
      message: {
        type: "string",
        description:
          'Plain-text body for action="send_email". Required. The email is always sent to your owner (the operator) — there is no recipient field.',
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
        description: 'Optional extra email headers for action="send_email" (e.g. {"X-Priority":"1"}).',
      },
      attachments: {
        type: "array",
        description:
          'Optional attachments for action="send_email". Each item is {"filename": string, "content_b64": base64-encoded bytes}.',
        items: {
          type: "object",
          properties: {
            filename: { type: "string" },
            content_b64: { type: "string" },
          },
          required: ["filename", "content_b64"],
        },
      },
    },
    actions: ["send_email"],
  };
}

export function describeClawBitsMessageTool(
  _params: ChannelMessageActionDiscoveryContext,
): ChannelMessageToolDiscovery {
  return {
    actions: CLAWBITS_ACTIONS,
    schema: [
      buildReactionSchemaFragment(),
      buildDescriptionSchemaFragment(),
      buildSendEmailSchemaFragment(),
    ],
  };
}

// ---------------------------------------------------------------------------
// Execution — translate the generic action call into a ClawBits HTTP call.
// ---------------------------------------------------------------------------

function readMessageId(params: Record<string, unknown>): string {
  const id = readStringParam(params, "messageId") ?? readStringParam(params, "message_id");
  if (!id) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "messageId (ClawBits post_id) is required.",
      path: "/",
    });
  }
  return id;
}

function readDescription(params: Record<string, unknown>): { description: string; truncated: boolean } {
  const raw = readStringParam(params, "description");
  if (!raw) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: 'description is required for action="update_description".',
      path: "/",
    });
  }
  const trimmed = raw.trim();
  const description = trimmed.length > 280 ? trimmed.slice(0, 280).trimEnd() : trimmed;
  return { description, truncated: description.length !== trimmed.length };
}

async function handleReact(ctx: ChannelMessageActionContext): Promise<AgentToolResult> {
  const account = resolveClawBitsAccount({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
  });
  if (!account.enabled) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "ClawBits account is disabled in config.",
      path: "/",
    });
  }
  const messageId = readMessageId(ctx.params);
  const emoji = readStringParam(ctx.params, "emoji");
  const remove = readBooleanParam(ctx.params, "remove");

  if (!emoji) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: 'Emoji is required for action="react".',
      path: "/",
    });
  }

  const client = buildClient(account);
  const answers = resolveKnownAnswers(account.knownAnswers);
  const updated = (await withChallenge(client, answers, (ans) =>
    mmTools.toggleReaction(client, messageId, emoji, ans),
  )) as {
    reactions?: Array<{
      emoji: string;
      count: number;
      human_ids?: Array<number | string>;
      agent_ids?: string[];
    }>;
  };

  // The server toggles unconditionally — we infer the resulting state by
  // looking at whether this agent's id appears in the bucket after the
  // call. If the caller asked to `remove` and we still appear, the second
  // call below cancels back to the desired state.
  const myAgentId = account.agentId ?? "";
  const bucket = updated?.reactions?.find((b) => b.emoji === emoji);
  const present = !!bucket && (bucket.agent_ids ?? []).includes(myAgentId);

  if (remove === true && present) {
    // Toggle once more so the net effect is "removed".
    const reToggled = (await withChallenge(client, answers, (ans) =>
      mmTools.toggleReaction(client, messageId, emoji, ans),
    )) as typeof updated;
    return jsonOk({
      action: "react",
      messageId,
      emoji,
      removed: emoji,
      reactions: reToggled?.reactions ?? [],
    });
  }

  return jsonOk({
    action: "react",
    messageId,
    emoji,
    [present ? "added" : "removed"]: emoji,
    reactions: updated?.reactions ?? [],
  });
}

async function handleUpdateDescription(ctx: ChannelMessageActionContext): Promise<AgentToolResult> {
  const account = resolveClawBitsAccount({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
  });
  if (!account.enabled) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "ClawBits account is disabled in config.",
      path: "/",
    });
  }
  if (!account.agentId) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "Updating the Clawbits profile description requires agentId on the account.",
      path: "/",
    });
  }
  const { description, truncated } = readDescription(ctx.params);
  const client = buildClient(account);
  const updated = await agentTools.updateAgentDescription(client, account.agentId, description);
  return jsonOk({
    action: "update_description",
    agentId: account.agentId,
    description: updated.description ?? description,
    description_generated_at: updated.description_generated_at ?? null,
    description_source: updated.description_source ?? null,
    truncated,
  });
}

function readSendEmailParams(params: Record<string, unknown>): {
  subject: string;
  message: string;
  headers?: Record<string, string>;
  attachments?: EmailSendAttachment[];
} {
  const subject = readStringParam(params, "subject");
  const message = readStringParam(params, "message") ?? readStringParam(params, "body");
  if (!subject) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: 'subject is required for action="send_email".',
      path: "/",
    });
  }
  if (!message) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: 'message is required for action="send_email".',
      path: "/",
    });
  }

  let headers: Record<string, string> | undefined;
  const rawHeaders = params["headers"];
  if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    const collected: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof v === "string") collected[k] = v;
    }
    if (Object.keys(collected).length > 0) headers = collected;
  }

  let attachments: EmailSendAttachment[] | undefined;
  const rawAtts = params["attachments"];
  if (Array.isArray(rawAtts)) {
    const collected: EmailSendAttachment[] = [];
    for (const entry of rawAtts) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const filename = typeof e["filename"] === "string" ? e["filename"] : undefined;
      const contentB64 = typeof e["content_b64"] === "string" ? e["content_b64"] : undefined;
      if (filename && contentB64) collected.push({ filename, content_b64: contentB64 });
    }
    if (collected.length > 0) attachments = collected;
  }

  return {
    subject,
    message,
    ...(headers ? { headers } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

async function handleSendEmail(ctx: ChannelMessageActionContext): Promise<AgentToolResult> {
  const account = resolveClawBitsAccount({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
  });
  if (!account.enabled) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "ClawBits account is disabled in config.",
      path: "/",
    });
  }
  if (!account.agentId) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "Sending email requires agentId on the account.",
      path: "/",
    });
  }
  const body = readSendEmailParams(ctx.params);
  const client = buildClient(account);
  const answers = resolveKnownAnswers(account.knownAnswers);
  const sent = await withChallenge(client, answers, (ans) =>
    emailTools.emailSend(client, account.agentId as string, body, ans),
  );

  // TEMPORARY: mirror the sent email into the operator DM channel so the owner
  // sees agent-initiated mail in chat too — email otherwise never touches the
  // DM surface. Best-effort: a failed mirror must not fail the send that already
  // succeeded. Posts are authored by the agent, so the chat inbound poller's
  // self-echo filter (inbound-poller.ts: `post.user_id === account.agentId`)
  // drops them — no re-ingestion loop.
  if (account.channelId) {
    try {
      await withChallenge(client, answers, (ans) =>
        mmTools.postToChannel(
          client,
          account.channelId as string,
          { message: frameEmailForDm({ kind: "sent", subject: body.subject, body: body.message }) },
          ans,
        ),
      );
    } catch (err) {
      logWarn(
        undefined,
        `[clawbits/${ctx.accountId ?? "default"}] send_email->DM mirror failed: ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  return jsonOk({
    action: "send_email",
    status: sent.status ?? "sent",
    to_addr: sent.to_addr ?? null,
    from_addr: sent.from_addr ?? null,
    subject: sent.subject ?? body.subject,
  });
}

async function handleReactions(ctx: ChannelMessageActionContext): Promise<AgentToolResult> {
  const messageId = readMessageId(ctx.params);
  const account = resolveClawBitsAccount({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
  });
  if (!account.enabled) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "ClawBits account is disabled in config.",
      path: "/",
    });
  }
  const client = buildClient(account);

  // ClawBits returns reactions inline on the post; the cheapest way to
  // read them is to fetch the post via the channel listing and pick the
  // matching post_id. This keeps the surface to a single GET and reuses
  // the existing `getChannelPosts` wrapper.
  if (!account.channelId) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "Reading reactions requires a channelId on the account.",
      path: "/",
    });
  }
  const listing = (await mmTools.getChannelPosts(client, account.channelId)) as {
    posts?: Array<{
      post_id: number;
      reactions?: Array<{
        emoji: string;
        count: number;
        human_ids?: Array<number | string>;
        agent_ids?: string[];
      }>;
    }>;
  };
  const target = listing?.posts?.find((p) => String(p.post_id) === messageId);
  return jsonOk({
    action: "reactions",
    messageId,
    reactions: target?.reactions ?? [],
  });
}

// ---------------------------------------------------------------------------
// Adapter object
// ---------------------------------------------------------------------------

export function createClawBitsActions(): ChannelMessageActionAdapter {
  return {
    describeMessageTool: describeClawBitsMessageTool,
    supportsAction: ({ action }: { action: ChannelMessageActionName }) =>
      (CLAWBITS_ACTIONS as readonly string[]).includes(action),
    handleAction: async (
      ctx: ChannelMessageActionContext,
    ): Promise<AgentToolResult> => {
      switch (ctx.action) {
        case "react":
          return await handleReact(ctx);
        case "reactions":
          return await handleReactions(ctx);
        case "update_description":
          return await handleUpdateDescription(ctx);
        case "send_email":
          return await handleSendEmail(ctx);
        default:
          throw new ClawBitsError({
            statusCode: 0,
            detail: `Unsupported ClawBits action: ${ctx.action}`,
            path: "/",
          });
      }
    },
  };
}

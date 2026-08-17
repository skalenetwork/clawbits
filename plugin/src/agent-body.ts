import { createHash } from "node:crypto";
import type { InboundContextPost, InboundFile } from "./inbound-poller.js";

/**
 * Per-message preamble prepended to inbound text before it reaches the
 * agent. The plugin is otherwise a pure transport — without this header,
 * the agent has no idea it is running inside Clawbits and cannot answer
 * questions about its environment.
 *
 * Kept concise because it ships with every turn. The full reference lives in
 * plugin/docs/CLAWBITS_IN_DEPTH.md for humans/tooling; this preamble is the
 * immediate runtime context the model actually sees.
 */
const CLAWBITS_CONTEXT_LINES = [
  "You are an OpenClaw agent reachable through Clawbits, a cloud collaboration",
  "hub for AI agents called Clawbots. Clawbits was previously named ClawBits;",
  "if a user, config key, API path, package, log, or old document says ClawBits,",
  "treat it as the legacy name for Clawbits.",
  "Messages addressed to you arrive via the Clawbits Mattermost-style channel",
  "surface from your human owner, an organization member, or a channel member.",
  "Clawbits provides agent identity, human ownership, organization approval",
  "flows, Proof-of-Cognition challenge gating, posts, channels/direct messages,",
  "shared files, lightweight publishing, Git repositories, action documents,",
  "profiles, optional email integration, and a human dashboard.",
  "When asked about Clawbits, ClawBits, channels, posts, owners, approvals,",
  "Proof-of-Cognition, files, repos, actions, email, or the dashboard, answer as",
  "a participant in this Clawbits environment. Prefer the name Clawbits.",
];

/**
 * Stable, opaque per-chat session id derived from the Clawbits chat (channel)
 * id. SHA-256 keeps the raw channel id out of the model- and user-facing
 * surface while staying deterministic: the same chat always yields the same
 * token, so the agent can report a consistent session id when asked. Truncated
 * to 12 hex chars — ample to disambiguate an org's chats without being unwieldy.
 */
export function clawbitsSessionId(chatId: string): string {
  const digest = createHash("sha256").update(`clawbits:session:${chatId}`).digest("hex");
  return `sess_${digest.slice(0, 12)}`;
}

/**
 * Assemble the bracketed Clawbits context block. When a hashed ``sessionId`` is
 * supplied it is woven in so the agent can answer "what is your session id?"
 * straight from context, with no tool call. The id is stable per chat, so the
 * block stays byte-identical across turns of the same conversation (prompt
 * cache safe within a session).
 *
 * ``agentId`` names the agent to itself. Without it the agent has no idea what
 * it is called — it cannot recognise "Scaleweld, any idea why…" as addressed to
 * it, and observed behaviour was an agent opening with "Who am I?". That gap
 * matters most on the LobsterTalk attention path: the server-side triage step
 * nudges partly *because* a message names the agent without an ``@`` (see
 * ``build_system_prompt`` in clawbits/lobstertalk/attention/triage.py), so
 * selecting on a signal the agent can't perceive produced silent NO_REPLYs.
 * Stated here rather than in the attention block because it is true on every
 * path; DMs and @mentions simply never needed it.
 */
function buildClawbitsContext(sessionId?: string, agentId?: string): string {
  const lines = ["[Clawbits context]", ...CLAWBITS_CONTEXT_LINES];
  if (agentId) {
    lines.push(
      `You are the Clawbits agent ${agentId}. People may address you by that name`,
      "without an @mention — treat a message that names you as directed at you.",
    );
  }
  if (sessionId) {
    lines.push(
      `Your Clawbits session id for this chat is ${sessionId}. If asked for your`,
      "session id (or which session/chat this is), report it exactly as written.",
    );
  }
  lines.push("[end Clawbits context]");
  return lines.join("\n");
}

const CLAWBITS_AGENT_PREAMBLE = buildClawbitsContext();

/**
 * A single inbound attachment that has been downloaded and persisted into the
 * host's media store. Produced by the attachment-saving path
 * (`saveInboundAttachmentsForAgent`) and consumed here when rendering the
 * attachments block.
 */
export interface SavedInboundMedia {
  fileId: string;
  path: string;
  contentType?: string;
}

/** One-line human-readable byte size. Strips a trailing ``.0`` so exact
 *  values read naturally (``2KB`` instead of ``2.0KB``). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const rendered = v.toFixed(v >= 10 || i === 0 ? 0 : 1).replace(/\.0$/, "");
  return `${rendered}${units[i]}`;
}

/** Render a structured attachments block the model can act on. Image
 *  files are emitted with markdown image syntax so multimodal harnesses
 *  can lift them into model inputs; non-image files appear as labelled
 *  links with size + MIME hints. Returns an empty string when there are
 *  no files (so the prompt stays clean for pure-text messages). */
function buildAttachmentsBlock(
  files: readonly InboundFile[] | undefined,
  savedByFileId?: ReadonlyMap<string, SavedInboundMedia>,
): string {
  if (!files || files.length === 0) return "";
  const lines: string[] = ["", "[Attachments]"];
  for (const f of files) {
    const size = formatBytes(f.sizeBytes);
    const isImage = f.contentType.toLowerCase().startsWith("image/");
    const saved = savedByFileId?.get(f.fileId);
    const url = saved?.path ?? "<attachment download unavailable; ask the user to re-upload if visual access is required>";
    const label = `${f.filename} [id=${f.fileId}] (${f.contentType}, ${size})`;
    if (isImage && saved?.path) {
      // Do not inline a local path as markdown image syntax here. OpenClaw
      // stages MediaPaths separately before the model runs; embedding the
      // pre-staged absolute path in user text can make multimodal adapters try
      // the wrong host path first and emit a confusing transient error.
      lines.push(`- ${label}: saved as inbound media`);
    } else {
      lines.push(`- ${label}: ${url}`);
    }
  }
  lines.push("[end Attachments]");
  return lines.join("\n");
}

/** Render the read-only catch-up history block. Each line attributes a
 *  prior post to its sender (the agent's own posts are labelled so the model
 *  doesn't mistake them for someone else) with a UTC timestamp. Returns an
 *  empty string when there's no backlog so the bare-message prompt shape is
 *  unchanged. */
function buildHistoryBlock(
  priorContext: readonly InboundContextPost[] | undefined,
  catchUp = false,
): string {
  if (!priorContext || priorContext.length === 0) return "";
  // The two framings are not interchangeable. A mention in a busy room comes
  // with background chatter nobody asked the agent about, so that block says
  // don't answer it. Catch-up is the opposite: these were addressed to the
  // agent while it was offline and are still unanswered, and recovering them
  // only to tell the model to ignore them is worse than not recovering them.
  const lines: string[] = catchUp
    ? [
        `[Missed while you were offline — ${priorContext.length} message(s), oldest first.`,
        "You were unreachable when these arrived and have not answered them yet.",
        "Address them together with the message that follows this block, in one reply.",
        "Don't apologise at length for the delay; just pick up where things left off.]",
      ]
    : [
        `[Channel history — ${priorContext.length} message(s) before you were tagged, oldest first.`,
        "Read-only context to catch up on the conversation; do not reply to these,",
        "only to the message that follows this block.]",
      ];
  for (const p of priorContext) {
    const who = p.isSelf ? "you" : p.senderId || "unknown";
    const when = Number.isFinite(p.createAt) ? new Date(p.createAt).toISOString() : "?";
    const text = p.text.trim().length > 0 ? p.text : "(no text)";
    lines.push(`${who} [${when}]: ${text}`);
  }
  lines.push(catchUp ? "[end Missed while you were offline]" : "[end Channel history]");
  return lines.join("\n");
}

function buildReplyTagBlock(senderTag: string | undefined): string {
  if (!senderTag) return "";
  return [
    "[Reply tagging]",
    `Start your reply to the current message with ${senderTag}.`,
    "[end Reply tagging]",
  ].join("\n");
}

/** Framing for a LobsterTalk attention nudge: the message below wasn't addressed
 *  to the agent, a server-side triage gate flagged it. Reply only if genuinely
 *  useful, so a soft nudge doesn't read as a command to respond. Empty string
 *  for ordinary (mention/DM) dispatches so their prompt shape is unchanged. */
function buildAttentionBlock(attention: boolean | undefined): string {
  if (!attention) return "";
  return [
    "[Attention]",
    "You were not directly mentioned. A triage step flagged the message below as",
    "one you might be able to help with. Reply only if you can add something",
    "genuinely useful right now; otherwise do not reply at all.",
    "[end Attention]",
  ].join("\n");
}

export function buildAgentBody(
  rawBody: string,
  files?: readonly InboundFile[],
  savedByFileId?: ReadonlyMap<string, SavedInboundMedia>,
  sessionId?: string,
  priorContext?: readonly InboundContextPost[],
  senderTag?: string,
  attention?: boolean,
  agentId?: string,
  catchUp?: boolean,
): string {
  // Without a session id *or* an agent id the context block is byte-identical
  // to the pre-feature preamble, so callers/tests that omit both keep the exact
  // old prompt shape. Either one folds into the bracketed context.
  const context =
    sessionId || agentId ? buildClawbitsContext(sessionId, agentId) : CLAWBITS_AGENT_PREAMBLE;
  const historyBlock = buildHistoryBlock(priorContext, catchUp === true);
  const replyTagBlock = buildReplyTagBlock(senderTag);
  const attentionBlock = buildAttentionBlock(attention);
  // Channel catch-up history sits between the Clawbits context and the
  // current message so the model reads the backlog before the ask. Reply
  // tagging and the attention framing follow it so the addressing rule and the
  // reply-only-if-useful instruction sit closest to the ask.
  const head = [context, historyBlock, replyTagBlock, attentionBlock]
    .filter(Boolean)
    .join("\n\n");
  const attachmentsBlock = buildAttachmentsBlock(files, savedByFileId);
  // The bare-text path (no attachments) keeps a stable prompt shape so prompt
  // caching / replay across upgrades stays stable within a session.
  if (!attachmentsBlock && rawBody) {
    return `${head}\n\n${rawBody}`;
  }
  // Either there's an attachment, an empty body, or both. When the body
  // is empty (attachment-only post), keep the prompt grammatical.
  const userBody = rawBody.trim().length > 0 ? rawBody : "(no message text — see attachments)";
  return `${head}\n\n${userBody}${attachmentsBlock}`;
}

// Thin HTTP wrappers for the Clawbits agent email API. Mirrors the style of
// `./mattermost.ts`: GETs ride the API key only (cheap, mirrors the inbound
// poller), while the paid `send` POST is challenge-gated and takes a
// `ChallengeAnswer` (same shape as `toggleReaction`).
//
// Endpoint family (all under the authenticated agent's own mailbox):
//   GET    /api/agentic/agents/{agent_id}/email/count
//   GET    /api/agentic/agents/{agent_id}/email/inbox?limit=&offset=
//   GET    /api/agentic/agents/{agent_id}/email/{message_uid}
//   POST   /api/agentic/agents/{agent_id}/email/send   (cost 1000 CB_TOKENS)
//
// See `docs/protocol/AGENT_EMAIL_API.md` in the Clawbits repo for the contract.

import type { ClawBitsClient } from "../client.js";
import type { ChallengeAnswer } from "../types.js";

/** Mailbox totals — the cheap poll the email poller leans on. */
export interface EmailCount {
  total: number;
  unread: number;
  email_address?: string;
}

/** One inbox listing row (no body). */
export interface EmailSummary {
  uid: number;
  from_addr?: string;
  to_addr?: string;
  subject?: string;
  date?: string;
  is_read?: boolean;
  size?: number;
}

export interface EmailListResponse {
  emails: EmailSummary[];
  total: number;
  unread_count: number;
  limit?: number;
  offset?: number;
}

/** A single attachment as returned on the detail fetch (inline base64). */
export interface EmailAttachment {
  filename: string;
  content_type?: string;
  size?: number;
  content_b64: string;
}

/** Full single-message fetch. Reading it marks the message read server-side. */
export interface EmailDetail {
  uid: number;
  from_addr?: string;
  to_addr?: string;
  subject?: string;
  date?: string;
  body_text?: string | null;
  body_html?: string | null;
  is_read?: boolean;
  size?: number;
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
}

/** Outbound attachment shape accepted by the send endpoint. */
export interface EmailSendAttachment {
  filename: string;
  content_b64: string;
}

export interface EmailSendRequest {
  subject: string;
  message: string;
  headers?: Record<string, string>;
  attachments?: EmailSendAttachment[];
}

export interface EmailSendResponse {
  status: string;
  from_addr?: string;
  to_addr?: string;
  subject?: string;
}

function emailBase(client: ClawBitsClient, agentId: string): string {
  return `/api/agentic/agents/${client.encodePath(agentId)}/email`;
}

/** Total + unread counts for the agent's mailbox. */
export async function emailCount(
  client: ClawBitsClient,
  agentId: string,
): Promise<EmailCount> {
  return client.request<EmailCount>("GET", `${emailBase(client, agentId)}/count`);
}

/** List inbox UIDs (newest first per the server). */
export async function emailInbox(
  client: ClawBitsClient,
  agentId: string,
  opts: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<EmailListResponse> {
  const params = new URLSearchParams();
  if (typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0) {
    params.set("limit", String(Math.floor(opts.limit)));
  }
  if (typeof opts.offset === "number" && Number.isFinite(opts.offset) && opts.offset > 0) {
    params.set("offset", String(Math.floor(opts.offset)));
  }
  const query = params.toString();
  return client.request<EmailListResponse>(
    "GET",
    `${emailBase(client, agentId)}/inbox${query ? `?${query}` : ""}`,
    { signal: opts.signal },
  );
}

/** Fetch one email by UID (full body + attachments). Marks it read. */
export async function emailGet(
  client: ClawBitsClient,
  agentId: string,
  messageUid: number | string,
  signal?: AbortSignal,
): Promise<EmailDetail> {
  return client.request<EmailDetail>(
    "GET",
    `${emailBase(client, agentId)}/${client.encodePath(String(messageUid))}`,
    { signal },
  );
}

/** Send an email from the agent to its operator. Challenge-gated + paid. */
export async function emailSend(
  client: ClawBitsClient,
  agentId: string,
  body: EmailSendRequest,
  answer: ChallengeAnswer,
  signal?: AbortSignal,
): Promise<EmailSendResponse> {
  return client.request<EmailSendResponse>(
    "POST",
    `${emailBase(client, agentId)}/send`,
    { json: body, challenge: answer, ...(signal ? { signal } : {}) },
  );
}

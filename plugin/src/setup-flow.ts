import { ClawBitsClient } from "./client.js";
import { ClawBitsError } from "./errors.js";
import { resolveKnownAnswers, withChallenge } from "./challenge.js";
import * as agentTools from "./tools/agents.js";
import * as authTools from "./tools/auth.js";
import * as mmTools from "./tools/mattermost.js";
import * as versionTools from "./tools/version.js";
import type { VersionCheckResponse } from "./tools/version.js";

const SIGNUP_MAX_ATTEMPTS = 16;
const SIGNUP_DELAY_MS = 150;
const APPROVAL_POLL_INTERVAL_MS = 3000;
const APPROVAL_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

export interface SignupFlowLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface SignupFlowProgress {
  onSignupRequested?: (request: {
    signupRequestId: string;
    approvalUrl?: string;
    agentId: string;
    status?: string;
  }) => void;
  onApprovalWaitStart?: (message: string) => void;
  onApprovalWaitUpdate?: (message: string) => void;
  onApprovalWaitStop?: (message?: string) => void;
}

export interface SignupFlowResult {
  agentId: string;
  apiKey: string;
  channelId?: string;
  status?: string;
  signupRequestId?: string;
  approvalUrl?: string;
  minted: boolean;
  greeted: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractSignupRequestStatus(payload: unknown): string | undefined {
  const obj = readObject(payload);
  if (!obj) return undefined;
  return (
    readString(obj["status"]) ??
    readString(readObject(obj["signup_request"])?.["status"]) ??
    readString(readObject(obj["request"])?.["status"]) ??
    readString(readObject(obj["data"])?.["status"])
  );
}

function extractTeamId(payload: unknown): string | undefined {
  const obj = readObject(payload);
  if (!obj) return undefined;
  return (
    readString(obj["team_id"]) ??
    readString(obj["id"]) ??
    readString(readObject(obj["team"])?.["team_id"]) ??
    readString(readObject(obj["team"])?.["id"]) ??
    readString(readObject(obj["data"])?.["team_id"]) ??
    readString(readObject(obj["data"])?.["id"])
  );
}

function extractChannelId(payload: unknown): string | undefined {
  const obj = readObject(payload);
  if (!obj) return undefined;
  return (
    readString(obj["channel_id"]) ??
    readString(obj["id"]) ??
    readString(readObject(obj["channel"])?.["channel_id"]) ??
    readString(readObject(obj["channel"])?.["id"]) ??
    readString(readObject(obj["data"])?.["channel_id"]) ??
    readString(readObject(obj["data"])?.["id"])
  );
}


async function resolveOperatorChannel(params: {
  client: ClawBitsClient;
  agentId: string;
  log?: SignupFlowLogger;
}): Promise<string> {
  const { client, agentId, log } = params;
  log?.info?.(`Clawbits: resolving operator communication channel for ${agentId}.`);
  const channel = await mmTools.getOperatorChannel(client, agentId);
  const channelId = extractChannelId(channel);
  if (!channelId) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: `operator channel response did not contain a channel id; response=${JSON.stringify(channel)}`,
      path: `/api/agentic/mm/teams/${agentId}/operator-channel`,
    });
  }
  log?.info?.(`Clawbits: operator communication channel = ${channelId}.`);
  return channelId;
}

async function waitForApproval(params: {
  client: ClawBitsClient;
  requestId: string;
  log?: SignupFlowLogger;
  progress?: SignupFlowProgress;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<string | undefined> {
  const {
    client,
    requestId,
    log,
    progress,
    timeoutMs = APPROVAL_WAIT_TIMEOUT_MS,
    pollIntervalMs = APPROVAL_POLL_INTERVAL_MS,
  } = params;
  progress?.onApprovalWaitStart?.("Waiting for organization approval...");
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | undefined;

  while (Date.now() < deadline) {
    const payload = await agentTools.getSignupRequest(client, requestId);
    const status = extractSignupRequestStatus(payload);
    if (status) {
      if (status !== lastStatus) {
        log?.info?.(`Clawbits: signup request status = ${status}.`);
        progress?.onApprovalWaitUpdate?.(`Approval status: ${status}`);
        lastStatus = status;
      }
      if (status === "approved") {
        progress?.onApprovalWaitStop?.("Owner approved. Continuing setup.");
        return status;
      }
      if (["rejected", "denied", "cancelled", "canceled", "failed"].includes(status)) {
        progress?.onApprovalWaitStop?.(`Signup ${status}.`);
        return status;
      }
    }
    await sleep(pollIntervalMs);
  }

  progress?.onApprovalWaitStop?.(
    lastStatus
      ? `Approval wait timed out (last status: ${lastStatus}).`
      : "Approval wait timed out.",
  );
  return lastStatus;
}

/**
 * Keep polling /signup until the server hands us a challenge we already
 * know the answer to. Server picks from a pool, so a few attempts are
 * typically enough.
 */
async function signupUntilKnown(
  client: ClawBitsClient,
  orgId: string,
  signupToken: string,
  answers: Record<string, string>,
): Promise<{ sessionToken: string; answer: string }> {
  let lastUnknown: string | undefined;
  for (let i = 0; i < SIGNUP_MAX_ATTEMPTS; i++) {
    const session = await agentTools.signup(client, { org_id: orgId, signup_token: signupToken });
    const answer = answers[session.challenge];
    if (answer !== undefined) {
      return { sessionToken: session.session_token, answer };
    }
    lastUnknown = session.challenge;
    if (i < SIGNUP_MAX_ATTEMPTS - 1) {
      await sleep(SIGNUP_DELAY_MS);
    }
  }
  throw new ClawBitsError({
    statusCode: 0,
    detail: `signup challenge_unknown after ${SIGNUP_MAX_ATTEMPTS} attempts (last: ${lastUnknown ?? "n/a"})`,
    path: "/api/agentic/auth/signup",
  });
}

/**
 * Per the Clawbits SIGNUP_PROCEDURE_SPEC: a fresh agent has 0 CB_TOKENS and
 * must mint (challenge → POST /api/agentic/auth/challenge_response) before any paid op.
 * Requires status === "approved"; pending agents cannot call this endpoint.
 */
async function mintInitialTokens(
  client: ClawBitsClient,
  answers: Record<string, string>,
): Promise<void> {
  if (!client.hasApiKey()) return;
  await withChallenge(client, answers, (ans) =>
    authTools.postResponse(client, {
      session_token: ans.sessionToken,
      response: ans.response,
    }),
  );
}

/**
 * Send one greeting message to the organization communication channel.
 * Best-effort, one-shot. Caller is responsible for persisting a `greeted`
 * flag so we do not re-hammer the channel across gateway restarts.
 */
function readOperatorDisplayName(info: unknown): string | undefined {
  if (!info || typeof info !== "object") return undefined;
  const name = (info as { operator_display_name?: unknown }).operator_display_name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

async function sendGreeting(
  client: ClawBitsClient,
  answers: Record<string, string>,
  channelId: string,
  agentId: string,
  orgId: string,
  log?: SignupFlowLogger,
): Promise<void> {
  // Try to address the operator by name — the agent just got approved
  // so /info is reachable. Fall back to the generic greeting if the
  // lookup fails or the operator has no display name set.
  let operatorName: string | undefined;
  try {
    const info = await agentTools.getAgentInfo(client, agentId);
    operatorName = readOperatorDisplayName(info);
  } catch (err) {
    log?.warn?.(
      `Clawbits: could not resolve operator display name for greeting (${describeError(err)})`,
    );
  }
  const message = operatorName
    ? `Hi ${operatorName}! Agent ${agentId} reporting in for ${orgId}.`
    : `Greetings from ${agentId} to organization ${orgId}!`;
  log?.info?.(`Clawbits: sending greeting to channel ${channelId}: ${message}`);
  await withChallenge(client, answers, (answer) =>
    mmTools.postToChannel(client, channelId, { message }, answer),
  );
}

// ---------------------------------------------------------------------------
// channel healthcheck — send + receive round trip
// ---------------------------------------------------------------------------

/** Why a healthcheck failed. Absent on success. */
export type ChannelHealthcheckFailureReason =
  | "send_failed"
  | "receive_failed"
  | "timeout";

export interface ChannelHealthcheckResult {
  /** True only when the probe was both posted and read back from the channel. */
  ok: boolean;
  channelId: string;
  /** Post id returned by the POST, when the server echoed one. */
  sentPostId?: string;
  /** Post id observed when the probe was read back. */
  observedPostId?: string;
  /** How many read attempts it took (0 means the send itself failed). */
  attempts: number;
  /** Wall-clock duration of the whole round trip in milliseconds. */
  latencyMs: number;
  /** Human-readable failure reason; absent on success. */
  error?: string;
  /**
   * Verdict from the version-check sub-step. Populated on every run that
   * reached the server; absent only when the version-check call itself
   * blew up before completing.
   */
  version?: VersionCheckResponse;
  /** Structured failure category for callers that want to branch on it. */
  reason?: ChannelHealthcheckFailureReason;
}

function describeError(err: unknown): string {
  if (err instanceof ClawBitsError) {
    const detail = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail);
    return `${err.statusCode} ${err.path} ${detail}`.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

function extractPostId(payload: unknown): string | undefined {
  const obj = readObject(payload);
  if (!obj) return undefined;
  const raw = obj["post_id"] ?? obj["id"] ?? obj["message_id"];
  if (typeof raw === "string" && raw) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/** Yield `{ id, message }` for each post in a list response, tolerating both
 *  the `{ posts: [...] }` array shape and the Mattermost `{ posts: {}, order }`
 *  map shape. */
function* iterateChannelPosts(payload: unknown): Generator<{ id?: string; message: string }> {
  const obj = readObject(payload);
  if (!obj) return;
  const posts = obj["posts"];
  if (Array.isArray(posts)) {
    for (const entry of posts) {
      const p = readObject(entry);
      if (!p) continue;
      const message = typeof p["message"] === "string" ? p["message"] : "";
      yield { id: extractPostId(p), message };
    }
    return;
  }
  const map = readObject(posts);
  if (map) {
    for (const entry of Object.values(map)) {
      const p = readObject(entry);
      if (!p) continue;
      const message = typeof p["message"] === "string" ? p["message"] : "";
      yield { id: extractPostId(p), message };
    }
  }
}

/**
 * Send one probe message to the channel and confirm it can be read back via
 * the same posts endpoint the inbound poller uses. This exercises the exact
 * outbound POST + inbound GET round trip a live agent depends on, so a
 * misconfigured endpoint, a broken challenge/credential, or a server that
 * accepts posts but never surfaces them is caught at install time instead of
 * silently swallowing the agent's replies.
 *
 * Best-effort and side-effecting: it posts a uniquely-tagged message to the
 * owner channel. The marker makes it obvious in the transcript that this was
 * an automated install check.
 */
export async function runChannelHealthcheck(params: {
  /** Client that already carries the agent api key. */
  client: ClawBitsClient;
  channelId: string;
  knownAnswersOverride?: Record<string, string>;
  log?: SignupFlowLogger;
  /** Override the probe marker (tests). */
  marker?: string;
  /** Max read-back attempts before giving up (default 12). */
  maxAttempts?: number;
  /** Delay between read attempts in ms (default 500). */
  pollIntervalMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}): Promise<ChannelHealthcheckResult> {
  const { client, channelId, log } = params;
  const answers = resolveKnownAnswers(params.knownAnswersOverride);
  const marker = params.marker ?? `clawbits-healthcheck ${globalThis.crypto.randomUUID()}`;
  const message = `:satellite: ${marker}`;
  const maxAttempts = Math.max(1, params.maxAttempts ?? 12);
  const pollIntervalMs = Math.max(0, params.pollIntervalMs ?? 500);
  const now = params.now ?? (() => Date.now());
  const startedAt = now();

  // Step 1 — version handshake. Cheap, always 200, no challenge gate. An
  // outdated plugin is surfaced as a warning only: the verdict rides along
  // on every result below so the CLI / status surface can still render an
  // actionable "please update" message, but setup is no longer blocked on
  // it — installs proceed even when running below the server's floor.
  let versionVerdict: VersionCheckResponse | undefined;
  try {
    versionVerdict = await versionTools.versionCheck(client);
  } catch (err) {
    log?.warn?.(`Clawbits: version-check call failed (${describeError(err)}).`);
  }
  if (versionVerdict && !versionVerdict.supported) {
    log?.warn?.(`Clawbits: plugin is outdated — ${versionVerdict.message ?? "update recommended"}. Continuing setup anyway.`);
  }

  log?.info?.(`Clawbits: healthcheck posting probe to channel ${channelId}.`);
  let sentPostId: string | undefined;
  try {
    const posted = await withChallenge(client, answers, (answer) =>
      mmTools.postToChannel(client, channelId, { message }, answer),
    );
    sentPostId = extractPostId(posted);
  } catch (err) {
    return {
      ok: false,
      channelId,
      attempts: 0,
      latencyMs: now() - startedAt,
      ...(versionVerdict ? { version: versionVerdict } : {}),
      reason: "send_failed",
      error: `send failed: ${describeError(err)}`,
    };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const payload = await mmTools.getChannelPosts(client, channelId);
      for (const post of iterateChannelPosts(payload)) {
        const matchesId = Boolean(sentPostId && post.id && post.id === sentPostId);
        const matchesMarker = post.message.includes(marker);
        if (matchesId || matchesMarker) {
          log?.info?.(`Clawbits: healthcheck probe observed on channel ${channelId}.`);
          return {
            ok: true,
            channelId,
            ...(sentPostId ? { sentPostId } : {}),
            ...(post.id ? { observedPostId: post.id } : {}),
            attempts: attempt,
            latencyMs: now() - startedAt,
            ...(versionVerdict ? { version: versionVerdict } : {}),
          };
        }
      }
    } catch (err) {
      if (attempt === maxAttempts) {
        return {
          ok: false,
          channelId,
          ...(sentPostId ? { sentPostId } : {}),
          attempts: attempt,
          latencyMs: now() - startedAt,
          ...(versionVerdict ? { version: versionVerdict } : {}),
          reason: "receive_failed",
          error: `receive failed: ${describeError(err)}`,
        };
      }
    }
    if (attempt < maxAttempts) {
      await sleep(pollIntervalMs);
    }
  }

  return {
    ok: false,
    channelId,
    ...(sentPostId ? { sentPostId } : {}),
    attempts: maxAttempts,
    latencyMs: now() - startedAt,
    ...(versionVerdict ? { version: versionVerdict } : {}),
    reason: "timeout",
    error: "probe was posted but never read back within the timeout",
  };
}

/**
 * Drive the full first-time-setup sequence with an already-constructed
 * client (no api key yet). Returns the resulting credentials and metadata
 * so the caller can write them back into `channels.clawbits.accounts.*`.
 */
export async function runSignupFlow(params: {
  client: ClawBitsClient;
  orgId: string;
  signupToken: string;
  knownAnswersOverride?: Record<string, string>;
  log?: SignupFlowLogger;
  progress?: SignupFlowProgress;
  /** If true, skip the MM channel auto-detect + greeting. */
  skipChannelBootstrap?: boolean;
  approvalWaitTimeoutMs?: number;
  approvalPollIntervalMs?: number;
}): Promise<SignupFlowResult> {
  const { client, orgId, signupToken, log } = params;
  const answers = resolveKnownAnswers(params.knownAnswersOverride);

  log?.info?.("Clawbits: requesting signup challenge...");
  const { sessionToken, answer } = await signupUntilKnown(client, orgId, signupToken, answers);
  log?.info?.("Clawbits: solved challenge, committing signup...");
  const created = await agentTools.commitSignup(client, {
    sessionToken,
    response: answer,
  });
  client.setApiKey(created.api_key);
  log?.info?.(`Clawbits: agent ${created.agent_id} provisioned.`);

  let effectiveStatus = created.status;
  if (effectiveStatus !== "approved" && created.signup_request_id) {
    params.progress?.onSignupRequested?.({
      signupRequestId: created.signup_request_id,
      ...(typeof created.approval_url === "string" && created.approval_url
        ? { approvalUrl: created.approval_url }
        : {}),
      agentId: created.agent_id,
      ...(effectiveStatus ? { status: String(effectiveStatus) } : {}),
    });
    log?.warn?.(
      `Clawbits: agent status '${effectiveStatus ?? "pending"}' — waiting for organization approval before continuing setup.`,
    );
    let waitedStatus: string | undefined;
    try {
      waitedStatus = await waitForApproval({
        client,
        requestId: created.signup_request_id,
        log,
        progress: params.progress,
        timeoutMs: params.approvalWaitTimeoutMs,
        pollIntervalMs: params.approvalPollIntervalMs,
      });
    } catch (err) {
      log?.warn?.(
        `Clawbits: approval polling failed; continuing with status '${effectiveStatus ?? "pending"}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (waitedStatus) effectiveStatus = waitedStatus;
    if (effectiveStatus && ["rejected", "denied", "cancelled", "canceled", "failed"].includes(effectiveStatus)) {
      throw new ClawBitsError({
        statusCode: 0,
        detail: `signup request ${created.signup_request_id} ended with status '${effectiveStatus}'`,
        path: `/api/agentic/agents/signup-requests/${created.signup_request_id}`,
      });
    }
    if (effectiveStatus === "approved") {
      await sleep(1500);
    }
  }

  let minted = false;
  if (effectiveStatus === "approved") {
    await mintInitialTokens(client, answers);
    minted = true;
    log?.info?.("Clawbits: minted initial CB_TOKENS.");
  } else {
    log?.warn?.(
      `Clawbits: agent status '${effectiveStatus ?? "pending"}' — approval still required before minting CB_TOKENS.`,
    );
  }

  let channelId: string | undefined;
  let greeted = false;
  if (!params.skipChannelBootstrap && effectiveStatus === "approved") {
    channelId = await resolveOperatorChannel({
      client,
      agentId: created.agent_id,
      log,
    });
    await sendGreeting(client, answers, channelId, created.agent_id, orgId, log);
    greeted = true;
    log?.info?.("Clawbits: greeted the organization channel on Mattermost.");
  }

  return {
    agentId: created.agent_id,
    apiKey: created.api_key,
    ...(channelId ? { channelId } : {}),
    ...(effectiveStatus ? { status: String(effectiveStatus) } : {}),
    ...(created.signup_request_id ? { signupRequestId: created.signup_request_id } : {}),
    ...(typeof created.approval_url === "string" && created.approval_url
      ? { approvalUrl: created.approval_url }
      : {}),
    minted,
    greeted,
  };
}

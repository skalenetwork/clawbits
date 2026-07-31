import type { ChannelGatewayContext } from "openclaw/plugin-sdk/core";
import { formatBytes, type SavedInboundMedia } from "./agent-body.js";
import { ClawBitsClient } from "./client.js";
import { logWarn } from "./file-logger.js";
import type { InboundFile, InboundMessage } from "./inbound-poller.js";
import type { ResolvedClawBitsAccount } from "./types.js";

/** Shared cap for media we decode + persist from a channel (chat + email).
 *  Matches the server's outbound cap (MM_FILES_MAX_BYTES, 15 MiB default) so
 *  any attachment another agent could post is also ingestible here. */
export const CLAWBITS_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
const CLAWBITS_ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;

export interface AgentMediaContext {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
}

function buildAgentMediaPayload(mediaList: readonly SavedInboundMedia[]): AgentMediaContext {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((m) => m.path);
  const mediaTypes = mediaList
    .map((m) => m.contentType)
    .filter((v): v is string => Boolean(v));
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

async function fetchAttachmentBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CLAWBITS_ATTACHMENT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: ac.signal });
    if (!response.ok) {
      throw new Error(`download failed: HTTP ${response.status}`);
    }
    const len = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(len) && len > maxBytes) {
      throw new Error(`attachment exceeds ${(maxBytes / (1024 * 1024)).toFixed(0)}MB limit`);
    }
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`attachment exceeds ${(maxBytes / (1024 * 1024)).toFixed(0)}MB limit`);
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the server for a fresh presigned GET. Swallows any error and returns
 * `null` so a flaky `/files/{id}/url` endpoint never short-circuits the
 * fallback path (the inline `file.downloadUrl` from the posts list is
 * already a valid presigned URL for images). Without this guard, a 500 on
 * the URL endpoint silently drops the attachment even when we have a
 * perfectly good URL in hand.
 */
async function requestFreshAttachmentUrl(
  file: InboundFile,
  client: ClawBitsClient | undefined,
): Promise<string | null> {
  if (!client) return null;
  try {
    const out = await client.request<{ url?: string }>(
      "GET",
      `/api/agentic/mm/files/${client.encodePath(file.fileId)}/url`,
    );
    return typeof out.url === "string" && out.url ? out.url : null;
  } catch {
    return null;
  }
}

async function fetchAttachmentForFile(
  file: InboundFile,
  client: ClawBitsClient | undefined,
): Promise<Uint8Array> {
  // Try the inline `download_url` from the posts list FIRST. `mm_list_posts`
  // already presigns image URLs server-side, so for the common case (image
  // attachments) we don't need a second round trip. Only on miss / failure
  // do we hit `/files/{id}/url` for a fresh URL. Ordering matters: previously
  // the fresh-URL call ran first and any error there killed the attachment.
  const tried = new Set<string>();
  let lastError: unknown;
  const tryUrl = async (url: string | null | undefined): Promise<Uint8Array | null> => {
    if (typeof url !== "string" || url.length === 0 || tried.has(url)) return null;
    tried.add(url);
    try {
      return await fetchAttachmentBytes(url, CLAWBITS_ATTACHMENT_MAX_BYTES);
    } catch (err) {
      lastError = err;
      return null;
    }
  };

  const inline = await tryUrl(file.downloadUrl);
  if (inline) return inline;

  const fresh = await tryUrl(await requestFreshAttachmentUrl(file, client));
  if (fresh) return fresh;

  throw lastError instanceof Error
    ? lastError
    : new Error("no download URL available for attachment");
}

export async function saveInboundAttachmentsForAgent(
  ctx: ChannelGatewayContext<ResolvedClawBitsAccount>,
  msg: InboundMessage,
  client: ClawBitsClient | undefined,
): Promise<{ mediaContext: AgentMediaContext; savedByFileId: Map<string, SavedInboundMedia> }> {
  const files = msg.files ?? [];
  if (files.length === 0) return { mediaContext: {}, savedByFileId: new Map() };

  const runtime = ctx.channelRuntime as {
    media?: { saveMediaBuffer?: unknown };
  } | undefined;
  const saveMediaBuffer = runtime?.media?.saveMediaBuffer;
  if (typeof saveMediaBuffer !== "function") {
    logWarn(
      ctx.log,
      `[clawbits/${ctx.accountId}] media runtime unavailable; attachments remain URL-only for ${msg.postId}`,
    );
    return { mediaContext: {}, savedByFileId: new Map() };
  }

  const saved: SavedInboundMedia[] = [];
  for (const file of files) {
    try {
      if (file.sizeBytes > CLAWBITS_ATTACHMENT_MAX_BYTES) {
        throw new Error(`attachment too large: ${formatBytes(file.sizeBytes)}`);
      }
      const bytes = await fetchAttachmentForFile(file, client);
      const result = await saveMediaBuffer(
        Buffer.from(bytes),
        file.contentType,
        "inbound",
        CLAWBITS_ATTACHMENT_MAX_BYTES,
        file.filename,
      );
      if (!result || typeof result !== "object") continue;
      const r = result as { path?: unknown; contentType?: unknown };
      if (typeof r.path !== "string" || !r.path) continue;
      saved.push({
        fileId: file.fileId,
        path: r.path,
        contentType: typeof r.contentType === "string" ? r.contentType : file.contentType,
      });
    } catch (err) {
      logWarn(
        ctx.log,
        `[clawbits/${ctx.accountId}] attachment ${file.fileId} (${file.filename}) not saved for ${msg.postId}: ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  return {
    mediaContext: buildAgentMediaPayload(saved),
    savedByFileId: new Map(saved.map((m) => [m.fileId, m])),
  };
}

/** Internal: exported only so unit tests can drive private helpers without
 *  routing through the full inbound dispatch pipeline. */
export const __attachmentsTest = {
  fetchAttachmentForFile,
  requestFreshAttachmentUrl,
};

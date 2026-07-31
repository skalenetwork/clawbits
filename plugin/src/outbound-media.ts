// Outbound media upload: turns a host-staged media reference (ctx.mediaUrl —
// a remote URL or an approved local path, e.g. an image the agent just
// generated with its own model) into an attached-ready Clawbits file_id.
//
// Primary path is the server's one-request *direct* upload route (server does
// the R2 PUT, probes dimensions, generates the thumbnail). Older servers that
// predate the route 404 — we then fall back to the presigned trio
// (reserve → PUT to R2 → confirm), where the confirm-time server probe still
// backfills image dimensions.
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/core";
import type { ClawBitsClient } from "./client.js";
import { withChallenge } from "./challenge.js";
import { ClawBitsError } from "./errors.js";
import { pluginDebug } from "./file-logger.js";
import * as mmTools from "./tools/mattermost.js";

/** Server-side default MM_FILES_MAX_BYTES — reject before buffering more. */
export const OUTBOUND_MEDIA_MAX_BYTES = 15 * 1024 * 1024;

/** Minimal extension map for content types the loader reports without a
 *  filename (generated images are usually png/jpeg/webp). */
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "application/pdf": ".pdf",
};

function basenameFromMediaUrl(mediaUrl: string): string | undefined {
  // Strip query/fragment, take the last path segment. Works for both URLs
  // and filesystem paths; returns undefined when nothing usable remains.
  const cleaned = mediaUrl.split(/[?#]/, 1)[0] ?? "";
  const base = cleaned.split(/[/\\]/).pop() ?? "";
  return base && base !== "." && base !== ".." ? base : undefined;
}

export function deriveFilename(
  mediaUrl: string,
  loaded: { fileName?: string; contentType?: string },
): string {
  const fromLoader = loaded.fileName?.trim();
  if (fromLoader) return fromLoader;
  const fromUrl = basenameFromMediaUrl(mediaUrl);
  // A basename without an extension (opaque media-store ids) still gets the
  // content-type extension appended so the server/frontend can sniff type
  // from the name when needed.
  const ext = EXT_BY_CONTENT_TYPE[(loaded.contentType ?? "").toLowerCase()] ?? "";
  if (fromUrl) return fromUrl.includes(".") ? fromUrl : `${fromUrl}${ext}`;
  return `media${ext || ".bin"}`;
}

function extractFileId(response: unknown): string {
  const fileId = (response as { file_id?: unknown } | null)?.file_id;
  if (typeof fileId !== "string" || !fileId) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "upload response carried no file_id",
      path: "/api/agentic/mm/files",
    });
  }
  return fileId;
}

/**
 * Load the media behind ``ctx.mediaUrl`` and upload it to the channel.
 * Returns the ``file_id`` to bind via ``file_ids`` on the post.
 */
export async function uploadOutboundMedia(params: {
  client: ClawBitsClient;
  answers: Record<string, string>;
  channelId: string;
  ctx: Pick<
    ChannelOutboundContext,
    "mediaUrl" | "mediaAccess" | "mediaLocalRoots" | "mediaReadFile"
  >;
}): Promise<string> {
  const { client, answers, channelId, ctx } = params;
  const mediaUrl = ctx.mediaUrl;
  if (!mediaUrl) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "sendMedia called without ctx.mediaUrl",
      path: "/",
    });
  }

  // The SDK loader handles both remote URLs and host-approved local paths
  // (generated images arrive as local media-store paths) and enforces the
  // byte cap while streaming, so an oversized file never fully buffers.
  const loaded = await loadOutboundMediaFromUrl(mediaUrl, {
    maxBytes: OUTBOUND_MEDIA_MAX_BYTES,
    ...(ctx.mediaAccess ? { mediaAccess: ctx.mediaAccess } : {}),
    ...(ctx.mediaLocalRoots ? { mediaLocalRoots: ctx.mediaLocalRoots } : {}),
    ...(ctx.mediaReadFile ? { mediaReadFile: ctx.mediaReadFile } : {}),
  });
  const bytes = new Uint8Array(
    loaded.buffer.buffer,
    loaded.buffer.byteOffset,
    loaded.buffer.byteLength,
  );
  const contentType = loaded.contentType || "application/octet-stream";
  const filename = deriveFilename(mediaUrl, loaded);

  try {
    const direct = await withChallenge(client, answers, (ans) =>
      mmTools.directFileUpload(client, channelId, filename, contentType, bytes, ans),
    );
    return extractFileId(direct);
  } catch (err) {
    // Only a 404 means "server predates the direct route" — fall back to
    // the presigned flow. Anything else (413/415/403/5xx) is a real error
    // the presigned path would hit too; surface it.
    if (!(err instanceof ClawBitsError) || err.statusCode !== 404) throw err;
    pluginDebug(
      `outbound-media: direct upload route unavailable (404); falling back to presigned flow for ${filename}`,
    );
  }

  const reserved = (await withChallenge(client, answers, (ans) =>
    mmTools.requestFileUpload(
      client,
      channelId,
      {
        filename,
        content_type: contentType,
        size_bytes: bytes.byteLength,
        has_thumbnail: false,
      },
      ans,
    ),
  )) as {
    file_id?: string;
    upload_url?: string;
    upload_headers?: Record<string, string>;
  };
  const fileId = extractFileId(reserved);
  if (!reserved.upload_url) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "reserve response carried no upload_url",
      path: "/api/agentic/mm/files",
    });
  }

  // Plain fetch, NOT client.request: the presigned URL lives on the R2 host
  // (client.request would prefix the API base URL and inject Authorization)
  // and Content-Type + Content-Length are part of the signature, so the
  // returned upload_headers must go on the wire verbatim with a fixed-length
  // body — no compression, no chunked streaming.
  const putResponse = await fetch(reserved.upload_url, {
    method: "PUT",
    headers: reserved.upload_headers ?? {},
    // Uint8Array is a valid fetch body at runtime but newer TS lib.dom
    // typings exclude it from BodyInit; the cast is safe (same note as
    // client.ts request()).
    body: bytes as unknown as BodyInit,
  });
  if (!putResponse.ok) {
    throw new ClawBitsError({
      statusCode: putResponse.status,
      detail: `presigned PUT failed: ${putResponse.status} ${putResponse.statusText}`,
      path: reserved.upload_url,
    });
  }

  // No dims: the server's confirm-time probe backfills width/height for
  // images (agent-surface parity with the human confirm route).
  await withChallenge(client, answers, (ans) =>
    mmTools.confirmFileUpload(client, fileId, { thumbnail_uploaded: false }, ans),
  );
  return fileId;
}

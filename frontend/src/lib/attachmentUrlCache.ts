/**
 * Stable presigned-URL cache for chat attachments.
 *
 * The backend re-signs ``download_url`` / ``thumbnail_url`` on every
 * post-list response, so the URL changes on each refetch (periodic
 * safety-net poll + SSE-driven invalidations) even when the underlying
 * R2 object hasn't. If we hand React a different src each time, the
 * browser cache misses and the image visibly reloads (flicker).
 *
 * This module remembers the *first* URL we saw for each ``file_id`` and
 * keeps returning it until the URL is close to its server-side TTL,
 * then accepts a fresh one. The expiry comes from the server (the
 * ``*_url_expires_at`` field on the file payload) — we can't infer it
 * from "when we received the URL" because the backend reuses cached
 * URLs for almost their full TTL, so a URL that just arrived may only
 * have seconds of validity left.
 */

interface CacheEntry {
  url: string;
  expiresAt: number; // ms since epoch
}

// Separate maps for original vs thumbnail since both flow through here.
const originalCache = new Map<string, CacheEntry>();
const thumbnailCache = new Map<string, CacheEntry>();

// Safety margin so we don't hand out a URL that expires mid-load.
const EXPIRY_SAFETY_MS = 60 * 1000;
// Fallback when the server didn't send an explicit expiry (older
// payloads, or non-image URLs that arrive without enrichment). The
// server signs with ttl=3600 by default; pretend the URL was just
// minted minus the safety buffer.
const FALLBACK_TTL_MS = (3600 - 60) * 1000;

function stable(
  cache: Map<string, CacheEntry>,
  fileId: string,
  freshUrl: string | null | undefined,
  freshExpiresAtSec: number | null | undefined,
): string | null {
  const now = Date.now();
  const cached = cache.get(fileId);
  if (cached && cached.expiresAt > now) return cached.url;
  if (freshUrl) {
    const expiresAt =
      typeof freshExpiresAtSec === "number"
        ? freshExpiresAtSec * 1000 - EXPIRY_SAFETY_MS
        : now + FALLBACK_TTL_MS;
    // Guard against a server expiry that's already in the past (would
    // make the entry useless on the next read). Only cache if there's
    // at least a few seconds of life left.
    if (expiresAt > now + 1000) {
      cache.set(fileId, { url: freshUrl, expiresAt });
    }
    return freshUrl;
  }
  return null;
}

export function stableDownloadUrl(
  fileId: string,
  freshUrl: string | null | undefined,
  freshExpiresAt?: number | null,
): string | null {
  return stable(originalCache, fileId, freshUrl, freshExpiresAt);
}

export function stableThumbnailUrl(
  fileId: string,
  freshUrl: string | null | undefined,
  freshExpiresAt?: number | null,
): string | null {
  return stable(thumbnailCache, fileId, freshUrl, freshExpiresAt);
}

/** Test/debug helper — clear both maps. Not used in production. */
export function clearAttachmentUrlCache(): void {
  originalCache.clear();
  thumbnailCache.clear();
}

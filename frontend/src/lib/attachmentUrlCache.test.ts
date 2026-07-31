import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAttachmentUrlCache,
  stableDownloadUrl,
  stableThumbnailUrl,
} from "@/lib/attachmentUrlCache";

describe("attachmentUrlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    clearAttachmentUrlCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  it("returns the cached url within its server-side expiry window", () => {
    const expiresAt = nowSec() + 3600;
    expect(stableDownloadUrl("f1", "https://a/url-1", expiresAt)).toBe(
      "https://a/url-1",
    );
    // Even when a different fresh URL arrives, the cache keeps returning
    // the first one until the server expiry approaches.
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(
      stableDownloadUrl("f1", "https://a/url-2", expiresAt + 1000),
    ).toBe("https://a/url-1");
  });

  it("accepts a fresh url once the server expiry (minus safety margin) passes", () => {
    const expiresAt = nowSec() + 3600;
    stableDownloadUrl("f1", "https://a/url-1", expiresAt);
    // Past the safety margin (60s before expiry): the cached entry is
    // considered stale and we accept whatever fresh URL we're given.
    vi.advanceTimersByTime((3600 - 30) * 1000);
    expect(
      stableDownloadUrl(
        "f1",
        "https://a/url-2",
        nowSec() + 3600,
      ),
    ).toBe("https://a/url-2");
  });

  it("does not extend lifetime when the backend serves a stale URL", () => {
    // Simulates the bug: backend cache holds a URL signed long ago, so
    // ``expires_at`` is only ~60s in the future even though we just
    // received it. The frontend must treat it as short-lived, not as
    // if it had a fresh 1h TTL.
    const expiresAt = nowSec() + 60;
    stableDownloadUrl("f1", "https://a/stale-url", expiresAt);
    vi.advanceTimersByTime(120 * 1000);
    // 2 minutes later, the original URL is already dead on R2. The
    // cache must hand back the fresh URL, not the stale one.
    expect(
      stableDownloadUrl("f1", "https://a/fresh", nowSec() + 3600),
    ).toBe("https://a/fresh");
  });

  it("falls back to a sensible local TTL when expiry is not supplied", () => {
    // Older payloads (or non-image flows that arrive without the
    // enrichment pass) may not carry ``*_url_expires_at``; we still
    // need to cache something to prevent flicker.
    stableThumbnailUrl("f1", "https://a/thumb", undefined);
    vi.advanceTimersByTime(30 * 1000);
    expect(stableThumbnailUrl("f1", "https://a/thumb-2", undefined)).toBe(
      "https://a/thumb",
    );
  });

  it("does not cache a URL whose server-side expiry is already in the past", () => {
    // A URL that arrives already-expired shouldn't be remembered — the
    // next refetch must be free to install a fresh one immediately.
    const expiresAt = nowSec() - 10;
    expect(stableDownloadUrl("f1", "https://a/dead", expiresAt)).toBe(
      "https://a/dead",
    );
    expect(
      stableDownloadUrl("f1", "https://a/fresh", nowSec() + 3600),
    ).toBe("https://a/fresh");
  });
});

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

// On a failed load, retry a few times with a cache-busting suffix and backoff
// before settling on the letter chip. This rides out the signup race (an
// avatar row is visible before its SVG lands in R2) and a Cloudflare-cached
// 404 on the bare key — each retry is a fresh edge-cache key — so the avatar
// self-heals within a second or two instead of staying a letter until the
// next remount. Healthy avatars load on the first try and never retry.
const RETRY_LIMIT = 3;
const RETRY_BASE_MS = 600;

interface AvatarProps {
  /** Server-provided avatar URL. Falls back to an initial-letter glyph
   *  when absent or the load fails. */
  src?: string | null;
  /** Display name — drives the initial-letter fallback and ``aria-label``. */
  name?: string | null;
  /** Render size in pixels. Drives both wrapper dimensions and fallback
   *  font size. Default 32. */
  size?: number;
  /** Optional extra classes merged into the wrapper element. */
  className?: string;
  /** Wrap in a rounded muted-bg square so transparent areas of the SVG
   *  read as a self-contained tile. Default true — matches the look
   *  of the legacy ``AgentFaceAvatar`` and ``UserAvatar``. */
  framed?: boolean;
}

/**
 * Unified avatar for users, agents, and channels.
 *
 * The actual SVG bytes live in R2 (see ``clawbits.avatars``) and are
 * fetched as a plain image — no client-side generation, no flicker on
 * subsequent renders. When ``src`` is missing or the network fetch
 * errors, the component degrades to an initial-letter chip so the UI
 * never shows a broken-image icon.
 */
export function Avatar({
  src,
  name,
  size = 32,
  className,
  framed = true,
}: AvatarProps) {
  // Load state keyed by src so a new URL (e.g. an avatar.version bump after a
  // re-upload) resets attempt + errored via the render-phase "adjust state
  // from props" idiom — same pattern as ``useResilientImage``.
  const [ld, setLd] = useState<{ src: string | null | undefined; attempt: number; errored: boolean }>(
    { src, attempt: 0, errored: false },
  );
  if (ld.src !== src) setLd({ src, attempt: 0, errored: false });

  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear any pending retry on unmount.
  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  const handleError = () => {
    // Hide the broken <img> right away so the letter shows during the backoff,
    // then re-mount with a fresh cache-busted URL on retry.
    setLd((s) => ({ ...s, errored: true }));
    if (ld.attempt < RETRY_LIMIT) {
      const next = ld.attempt + 1;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => {
        setLd((s) => (s.src === src ? { ...s, attempt: next, errored: false } : s));
      }, RETRY_BASE_MS * next);
    }
  };

  // Corners stay rounded even when ``framed`` is false so the avatar
  // reads as a tile in dense contexts (mention picker, agent chip) where
  // the parent intentionally suppresses the muted backdrop. ``framed``
  // now only gates the background fill.
  const wrapper = cn(
    "inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-lg",
    framed && "bg-muted",
    className,
  );

  if (src && !ld.errored) {
    const bustedSrc =
      ld.attempt > 0 ? `${src}${src.includes("?") ? "&" : "?"}_r=${String(ld.attempt)}` : src;
    return (
      <span className={wrapper} style={{ width: size, height: size }}>
        <img
          src={bustedSrc}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={handleError}
          style={{
            width: size,
            height: size,
            display: "block",
            pointerEvents: "none",
          }}
        />
      </span>
    );
  }

  // Initial-letter fallback. Capitalises the first non-whitespace
  // character of the name; "?" when no name is provided so a stray
  // avatar without context still renders something deliberate.
  const initial = ((name ?? "").trim().charAt(0) || "?").toUpperCase();
  return (
    <span
      className={cn(wrapper, "font-medium text-muted-foreground")}
      style={{
        width: size,
        height: size,
        // Roughly half the box, with a hard floor so 10px avatars still
        // show a legible glyph in the sidebar's last-message snippet.
        fontSize: Math.max(10, Math.round(size * 0.45)),
      }}
      aria-label={name ?? undefined}
    >
      {initial}
    </span>
  );
}

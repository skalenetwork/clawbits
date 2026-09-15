import { memo, useState } from "react";

import { useLinkPreview } from "@/hooks/useLinkPreview";
import type { MmPostLinkPreviewEmbedded } from "@/lib/api";

interface LinkPreviewCardProps {
  /** URL to unfurl client-side. Mutually exclusive with ``embedded``. */
  url?: string;
  /** Pre-resolved OG card from the server. When provided, the component
   *  renders synchronously on first paint — no fetch, no skeleton, no
   *  layout shift. New posts go through this path; legacy posts (or
   *  posts whose server-side unfurl failed) fall back to ``url`` + the
   *  async client fetch. */
  embedded?: MmPostLinkPreviewEmbedded | null;
}

interface TwitterMeta {
  displayName: string;
  username: string;
}

/** Common shape both ``LinkPreviewData`` (client-fetched) and
 *  ``MmPostLinkPreviewEmbedded`` (server-resolved) reduce to. Keeps the
 *  render path identical regardless of source. ``image_url``/``title``
 *  etc. are tolerated as ``undefined`` on the embedded variant since the
 *  Pydantic model treats null + missing the same way. */
interface LinkPreviewLike {
  url: string;
  canonical_url: string | null | undefined;
  title: string | null | undefined;
  description: string | null | undefined;
  image_url: string | null | undefined;
  site_name: string | null | undefined;
  error: string | null | undefined;
}

function toLinkPreviewLike(embedded: MmPostLinkPreviewEmbedded): LinkPreviewLike {
  return {
    url: embedded.url,
    canonical_url: embedded.canonical_url,
    title: embedded.title,
    description: embedded.description,
    image_url: embedded.image_url,
    site_name: embedded.site_name,
    error: embedded.error,
  };
}

const TWITTER_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "www.x.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

/** Detect an X/Twitter post and pull out the author's display name +
 *  @handle from the OG title. X formats it as
 *  ``"{Display Name} (@{handle}) on X"`` — we strip the trailing
 *  " on X" suffix and surface the handle separately so the tweet body
 *  (OG description) can move into the primary slot. */
function parseTwitterMeta(preview: LinkPreviewLike): TwitterMeta | null {
  let host: string;
  try {
    host = new URL(preview.url).host.toLowerCase();
  } catch {
    return null;
  }
  if (!TWITTER_HOSTS.has(host)) return null;
  if (!preview.title) return null;
  const match = /^(.+?)\s+\(@(\w+)\)(?:\s+on\s+(?:X|Twitter))?\s*$/.exec(preview.title);
  if (!match) return null;
  const displayName = match[1];
  const username = match[2];
  if (displayName === undefined || username === undefined) return null;
  return { displayName: displayName.trim(), username };
}

/** Direct same-origin favicon URL — every host's ``/favicon.ico`` is
 *  expected to exist (the browser already requests it for tabs). Going
 *  via the upstream host avoids leaking the click to a third-party
 *  favicon service. Sites that serve their icon at a non-root path
 *  will simply fail to load and the chip falls back to plain text. */
function getFaviconUrl(pageUrl: string): string | null {
  try {
    return `${new URL(pageUrl).origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/** OpenGraph card rendered under a chat message for a given URL.
 *
 *  - While the unfurl request is in flight, renders a height-reserved
 *    skeleton card (image slot at the real 1.91:1 aspect ratio + two
 *    pulsing text bars). This commits the row's final height at first
 *    paint so the virtualizer doesn't shove rows below when the real
 *    content lands a beat later.
 *  - Once loaded, renders nothing when the server returned an error or
 *    there's no usable title — better to show no card than a half-empty
 *    one with just a domain. The collapse uses CSS transition so the
 *    height drop reads as deliberate rather than a snap.
 *  - Clicking the card opens the URL in a new tab.
 *  - The image is lazy-loaded; the OG 1.91:1 aspect ratio reserves
 *    space so the row height doesn't jump when bytes arrive. */
export const LinkPreviewCard = memo(function LinkPreviewCard({
  url,
  embedded,
}: LinkPreviewCardProps) {
  // Embedded → render immediately, never hit the network. The
  // server-side resolver only persists previews that have at least a
  // title or image, so the height of this card is committed at first
  // paint and never shrinks. The client fetch path stays as a fallback
  // for legacy posts only — gate the hook so it doesn't fire when we
  // already have the embedded result.
  const useClientFetch = embedded == null && Boolean(url);
  const { data: clientPreview, isLoading } = useLinkPreview(
    useClientFetch ? (url!) : "",
  );
  const preview: LinkPreviewLike | null = embedded
    ? toLinkPreviewLike(embedded)
    : clientPreview;
  const [imageFailed, setImageFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);

  // Loading: render a skeleton that mirrors the real card's shape so
  // the row height is committed before the unfurl resolves. Same
  // ``max-w-md`` + rounded-xl + border container as the real card.
  // Only the client-fetch path can be in this state — embedded posts
  // resolve synchronously above.
  if (useClientFetch && isLoading) {
    return <LinkPreviewSkeleton />;
  }

  if (!preview || preview.error) return null;
  if (!preview.title) return null;

  const href = preview.canonical_url ?? preview.url;
  const showImage = Boolean(preview.image_url) && !imageFailed;
  const twitter = parseTwitterMeta(preview);
  const faviconSrc = !faviconFailed ? getFaviconUrl(href) : null;
  // unavatar.io resolves a public profile avatar from the handle. If it
  // 404s or the user blocks it, we fall back to a handle-only meta row.
  const avatarSrc = twitter && !avatarFailed
    ? `https://unavatar.io/x/${encodeURIComponent(twitter.username)}`
    : null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-link-preview
      className="mt-2 block max-w-80 overflow-hidden rounded-xl border border-border/40 bg-muted/50 transition-transform duration-150 ease-out active:scale-[0.99] dark:bg-muted/30"
    >
      {showImage && (
        <img
          src={preview.image_url ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => { setImageFailed(true); }}
          className="aspect-[1.91/1] w-full object-cover"
        />
      )}
      <div className={`flex flex-col px-3 py-2.5 ${twitter ? "gap-2" : "gap-1"}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {twitter ? (
              <div className="flex min-w-0 items-center gap-2">
                {avatarSrc && (
                  <img
                    src={avatarSrc}
                    alt=""
                    width={28}
                    height={28}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    onError={() => { setAvatarFailed(true); }}
                    className="size-7 shrink-0 rounded-full bg-background object-cover"
                  />
                )}
                <div className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-[13px] font-semibold text-foreground">
                    {twitter.displayName}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    @{twitter.username}
                  </span>
                </div>
              </div>
            ) : (
              <div className="line-clamp-2 text-[13px] font-semibold leading-snug text-foreground">
                {preview.title}
              </div>
            )}
          </div>
          {preview.site_name && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {faviconSrc && (
                <img
                  src={faviconSrc}
                  alt=""
                  width={12}
                  height={12}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  onError={() => { setFaviconFailed(true); }}
                  className="size-3 shrink-0 rounded-sm"
                />
              )}
              <span className="max-w-[6rem] truncate">{preview.site_name}</span>
            </span>
          )}
        </div>
        {twitter
          ? preview.description && (
              <div className="line-clamp-4 whitespace-pre-line text-[13px] leading-normal text-foreground/95">
                {preview.description}
              </div>
            )
          : preview.description && (
              <div className="line-clamp-2 text-xs leading-normal text-muted-foreground">
                {preview.description}
              </div>
            )}
      </div>
    </a>
  );
});

/**
 * Height-reserved skeleton rendered while the unfurl is in flight.
 *
 * The shape mirrors the real card exactly — same outer container, same
 * 1.91:1 image slot, same padded text block with two stub lines — so
 * the swap to real content (or to ``null`` on error) doesn't shift the
 * row. We include the image slot unconditionally because most URLs
 * shared in chat (Twitter, YouTube, news, blogs) have OG images; the
 * minority case (no image) shrinks the row once after the request
 * resolves, which is a less disruptive shift than the pre-skeleton
 * "card appears from nothing" behavior.
 */
function LinkPreviewSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-link-preview-skeleton
      className="mt-2 block max-w-80 overflow-hidden rounded-xl border border-border/40 bg-muted/50 dark:bg-muted/30"
    >
      <div className="aspect-[1.91/1] w-full animate-pulse bg-muted/50"/>
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <div className="h-3.5 w-3/4 animate-pulse rounded-md bg-muted/60"/>
        <div className="h-3 w-5/6 animate-pulse rounded-md bg-muted/50"/>
        <div className="h-3 w-2/3 animate-pulse rounded-md bg-muted/50"/>
      </div>
    </div>
  );
}

import { openBrowserAsync } from 'expo-web-browser';
import { Image } from 'expo-image';
import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useLinkPreview } from '@/hooks/use-link-preview';
import { useTheme } from '@/hooks/use-theme';
import type { MmPostLinkPreviewEmbedded } from '@/lib/api';

interface LinkPreviewCardProps {
  /** URL to unfurl client-side. Used only as a fallback for legacy
   *  posts predating server-side embedding. Mutually exclusive with
   *  ``embedded``. */
  url?: string;
  /** Server-resolved OG card embedded on the post at publish/edit time.
   *  When provided, the card renders synchronously on first paint — no
   *  network fetch, no skeleton, no layout shift. The fallback path
   *  (``url`` + ``useLinkPreview``) only kicks in for posts predating
   *  the server-side unfurl rollout. */
  embedded?: MmPostLinkPreviewEmbedded | null;
  /** Outgoing (blue-bubble) messages get a slightly different palette so
   *  the card doesn't fight the bubble's blue. Twitter cards still use
   *  the tweet-shaped layout — only the palette swaps. */
  isOutgoing: boolean;
}

/** Common shape that both the client-fetched ``LinkPreviewData`` and the
 *  server-embedded ``MmPostLinkPreviewEmbedded`` reduce to. Keeps the
 *  render path below identical regardless of source. */
type LinkPreviewLike = {
  url: string;
  canonical_url: string | null | undefined;
  title: string | null | undefined;
  description: string | null | undefined;
  image_url: string | null | undefined;
  site_name: string | null | undefined;
  error: string | null | undefined;
};

function embeddedToLike(p: MmPostLinkPreviewEmbedded): LinkPreviewLike {
  return {
    url: p.url,
    canonical_url: p.canonical_url,
    title: p.title,
    description: p.description,
    image_url: p.image_url,
    site_name: p.site_name,
    error: p.error,
  };
}

interface TwitterMeta {
  displayName: string;
  username: string;
}

const TWITTER_HOSTS = new Set([
  'x.com',
  'twitter.com',
  'www.x.com',
  'www.twitter.com',
  'mobile.twitter.com',
]);

/** Detect an X/Twitter post and pull the author's display name + @handle
 *  from the OG title. X formats it as ``"{Display Name} (@{handle}) on
 *  X"`` — we strip the trailing " on X" suffix and surface the handle
 *  separately so the tweet body (OG description) can move into the
 *  primary slot. */
function parseTwitterMeta(preview: LinkPreviewLike): TwitterMeta | null {
  let host: string;
  try {
    host = new URL(preview.url).host.toLowerCase();
  } catch {
    return null;
  }
  if (!TWITTER_HOSTS.has(host)) return null;
  if (!preview.title) return null;
  const match = preview.title.match(
    /^(.+?)\s+\(@(\w+)\)(?:\s+on\s+(?:X|Twitter))?\s*$/,
  );
  if (!match) return null;
  const displayName = match[1];
  const username = match[2];
  if (displayName === undefined || username === undefined) return null;
  return { displayName: displayName.trim(), username };
}

/** Direct same-origin favicon URL — most hosts expose ``/favicon.ico``
 *  at the root, and going via the upstream host (which we've already
 *  hit for the OG image) avoids leaking the click to a third-party
 *  favicon service. Sites without an icon at that path just fail to
 *  load and the chip falls back to plain text. */
function getFaviconUrl(pageUrl: string): string | null {
  try {
    return `${new URL(pageUrl).origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/** ``#RRGGBB`` → ``rgba(r, g, b, alpha)``. Used to derive a chip
 *  background from ``theme.text`` so the chip is a touch lighter in
 *  dark mode and a touch darker in light mode without needing a
 *  dedicated palette entry. */
function alphaHex(hex: string, alpha: number): string {
  const m = hex.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

/** OpenGraph card rendered under a chat bubble for a given URL.
 *
 *  - Renders nothing while loading, when the server returned an error,
 *    or when there's no usable title — better to show no card than a
 *    half-empty one with just a domain.
 *  - Tapping the card opens the URL in the in-app browser (same path
 *    the inline markdown link uses).
 *  - X/Twitter URLs get a tweet-shaped layout: bigger primary tweet
 *    body, secondary display name + ``@handle`` row with the author's
 *    avatar pulled from unavatar.io.
 *  - All other sites get the generic layout: title primary, description
 *    secondary, site favicon + name chip floating top-right.
 *  - The image and favicon use ``expo-image`` so they benefit from the
 *    existing memory + disk cache — once cached, repeat renders are
 *    instant. */
export const LinkPreviewCard = memo(function LinkPreviewCard({
  url,
  embedded,
  isOutgoing,
}: LinkPreviewCardProps) {
  const theme = useTheme();
  // Embedded short-circuits the network — the server-side resolver only
  // persists previews that have at least a title or image, so the card
  // height is committed at first paint and never shrinks. Client fetch
  // remains as a fallback path for legacy posts only; the hook is gated
  // by ``url`` length so passing an empty string when ``embedded`` is
  // present skips it without an extra branch.
  const useClientFetch = embedded == null && Boolean(url);
  const clientPreview = useLinkPreview(useClientFetch ? (url as string) : '');
  const preview: LinkPreviewLike | null = embedded
    ? embeddedToLike(embedded)
    : (clientPreview as LinkPreviewLike | null);
  const [imageFailed, setImageFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);

  if (!preview || preview.error) return null;
  if (!preview.title) return null;

  const href = preview.canonical_url ?? preview.url;
  const showImage = Boolean(preview.image_url) && !imageFailed;
  const twitter = parseTwitterMeta(preview);
  const faviconSrc = !faviconFailed ? getFaviconUrl(href) : null;
  const avatarSrc = twitter && !avatarFailed
    ? `https://unavatar.io/x/${encodeURIComponent(twitter.username)}`
    : null;

  const cardBg = isOutgoing ? 'rgba(255,255,255,0.16)' : theme.backgroundElement;
  const accent = isOutgoing ? '#FFFFFF' : theme.text;
  const subText = isOutgoing ? 'rgba(255,255,255,0.78)' : theme.textSecondary;
  // Chip bg derives from the foreground color at low alpha — yields a
  // light tint in dark mode and a dark tint in light mode (same trick
  // the web card uses via ``bg-foreground/10``).
  const chipBg = isOutgoing
    ? 'rgba(255,255,255,0.18)'
    : alphaHex(theme.text, 0.1);
  const avatarBg = isOutgoing ? 'rgba(255,255,255,0.18)' : theme.background;

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${preview.title}`}
      onPress={() => {
        void openBrowserAsync(href).catch(() => {});
      }}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: cardBg },
        pressed && styles.cardPressed,
      ]}>
      {preview.image_url ? (
        showImage ? (
          <Image
            source={{ uri: preview.image_url }}
            style={styles.image}
            contentFit="cover"
            // Match placeholder fit so the bytes colour the already-reserved
            // box without a hop.
            placeholderContentFit="cover"
            cachePolicy="memory-disk"
            transition={120}
            accessible={false}
            onError={() => { setImageFailed(true); }}
          />
        ) : (
          // Image failed to load (404 / timeout). Keep the SAME fixed-aspect
          // box as a neutral placeholder instead of removing it — otherwise the
          // card collapses ~178px and reflows everything below it (a visible
          // jump right after the chat opens).
          <View style={[styles.image, { backgroundColor: chipBg }]} />
        )
      ) : null}
      <View style={[styles.body, twitter ? styles.bodyTwitter : null]}>
        <View style={styles.metaRow}>
          <View style={styles.metaLeft}>
            {twitter ? (
              <View style={styles.tweetMeta}>
                {avatarSrc ? (
                  <Image
                    source={{ uri: avatarSrc }}
                    style={[styles.avatar, { backgroundColor: avatarBg }]}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    transition={80}
                    accessible={false}
                    onError={() => { setAvatarFailed(true); }}
                  />
                ) : null}
                <View style={styles.tweetMetaText}>
                  <Text
                    style={[styles.displayName, { color: accent }]}
                    numberOfLines={1}>
                    {twitter.displayName}
                  </Text>
                  <Text
                    style={[styles.handle, { color: subText }]}
                    numberOfLines={1}>
                    @{twitter.username}
                  </Text>
                </View>
              </View>
            ) : (
              <Text
                style={[styles.title, { color: accent }]}
                numberOfLines={2}>
                {preview.title}
              </Text>
            )}
          </View>
          {preview.site_name ? (
            <View style={[styles.chip, { backgroundColor: chipBg }]}>
              {faviconSrc ? (
                <Image
                  source={{ uri: faviconSrc }}
                  style={styles.favicon}
                  contentFit="contain"
                  cachePolicy="memory-disk"
                  transition={80}
                  accessible={false}
                  onError={() => { setFaviconFailed(true); }}
                />
              ) : null}
              <Text
                style={[styles.chipText, { color: subText }]}
                numberOfLines={1}>
                {preview.site_name}
              </Text>
            </View>
          ) : null}
        </View>
        {twitter ? (
          preview.description ? (
            <Text
              style={[styles.tweetBody, { color: accent }]}
              numberOfLines={6}>
              {preview.description}
            </Text>
          ) : null
        ) : preview.description ? (
          <Text
            style={[styles.description, { color: subText }]}
            numberOfLines={2}>
            {preview.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  avatar: {
    borderRadius: 16,
    height: 32,
    width: 32,
  },
  body: {
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  bodyTwitter: {
    // X/Twitter cards put a bit more breathing room above the tweet
    // body so the smaller meta row doesn't feel glued to the primary
    // text — same vertical rhythm the web card uses.
    gap: 12,
  },
  card: {
    borderRadius: 16,
    marginTop: 8,
    maxWidth: 340,
    minWidth: 240,
    overflow: 'hidden',
  },
  cardPressed: {
    transform: [{ scale: 0.99 }],
  },
  chip: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    flexShrink: 0,
    gap: 6,
    maxWidth: 140,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '500',
  },
  description: {
    fontSize: 13,
    letterSpacing: -0.1,
    lineHeight: 18,
  },
  displayName: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
  },
  favicon: {
    borderRadius: 3,
    height: 14,
    width: 14,
  },
  handle: {
    fontSize: 12,
    lineHeight: 16,
  },
  image: {
    aspectRatio: 1.91, // OpenGraph spec — 1200x630 is the most common.
    width: '100%',
  },
  metaLeft: {
    flex: 1,
  },
  metaRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.2,
    lineHeight: 20,
  },
  tweetBody: {
    fontSize: 15,
    lineHeight: 21,
  },
  tweetMeta: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  tweetMetaText: {
    flex: 1,
  },
});

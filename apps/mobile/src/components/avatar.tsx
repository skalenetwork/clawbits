import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { loadSvg } from '@/lib/avatar-cache';
import { useTheme } from '@/hooks/use-theme';

interface AvatarProps {
  /** Server-provided avatar URL. Falls back to an initial-letter glyph
   *  when absent or the load fails. */
  uri?: string | null;
  /** Display name — drives the initial-letter fallback. */
  name?: string | null;
  /** Render size in pixels. Default 32. */
  size?: number;
  /** Wrap in a rounded muted-bg square so transparent areas of the SVG
   *  read as a self-contained tile. Default true. */
  framed?: boolean;
  /** Optional extra styles merged into the wrapper. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Mobile counterpart of ``frontend/src/components/Avatar.tsx``.
 *
 * Renders the server-hosted SVG (or WebP for uploaded avatars) via
 * ``expo-image``, which supports SVG natively on iOS / Android / Web in
 * SDK 56. Degrades to an initial-letter chip when the URL is missing or
 * the network fetch fails — same behaviour as the web component, so the
 * UI never shows a broken-image placeholder.
 */
export function Avatar({ uri, name, size = 32, framed = true, style }: AvatarProps) {
  const theme = useTheme();

  const wrapper: StyleProp<ViewStyle> = [
    styles.wrapper,
    { width: size, height: size, borderRadius: Math.round(size * 0.22) },
    framed ? { backgroundColor: theme.backgroundSelected } : null,
    style,
  ];

  const initial = ((name ?? '').trim().charAt(0) || '?').toUpperCase();
  // Roughly half the box, with a hard floor so tiny avatars still render
  // a legible glyph (matches the web component's fallback sizing).
  const fontSize = Math.max(10, Math.round(size * 0.45));
  const fallbackGlyph = (
    <Text
      style={[styles.initial, { color: theme.textSecondary, fontSize }]}
      accessibilityLabel={name ?? undefined}>
      {initial}
    </Text>
  );

  if (uri) {
    // Server-side generated avatars are SVGs whose ``glass`` style relies
    // on ``<feGaussianBlur>`` filters — ``expo-image``'s SVG decoder on
    // iOS strips those filters and renders the colored blocks with hard
    // edges. react-native-svg supports the full filter set, so route
    // every ``.svg`` URL through it; raster uploads (.webp from user
    // uploads) keep using ``expo-image`` for its disk cache + smooth
    // transitions.
    const isSvg = uri.toLowerCase().split('?')[0]?.endsWith('.svg') ?? false;
    return (
      <View style={wrapper}>
        {isSvg ? (
          <RemoteSvg uri={uri} size={size} fallback={fallbackGlyph} />
        ) : (
          // No per-instance ``errored`` latch — ``expo-image`` already has
          // its own retry-on-remount semantics, and latching meant a
          // single transient failure stayed broken until the bubble
          // unmounted (which in a chat list is essentially never).
          <Image
            source={{ uri }}
            style={{ width: size, height: size }}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={120}
            accessible={false}
          />
        )}
      </View>
    );
  }

  return <View style={wrapper}>{fallbackGlyph}</View>;
}

/** Fetches the SVG text via React Query (shared cache across every
 *  Avatar instance) and feeds it through ``inlineDataUriImages`` before
 *  rendering. The inlining step rewrites stitched user-avatar SVGs that
 *  embed inner SVGs as base64 data URIs — ``react-native-svg``'s native
 *  ``<image>`` doesn't recursively decode SVG data URIs, so without
 *  this pass the stitched user tiles render as empty squares. */
function RemoteSvg({
  uri,
  size,
  fallback,
}: {
  uri: string;
  size: number;
  fallback: React.ReactElement;
}) {
  const query = useQuery({
    queryKey: ['avatar-svg', uri],
    queryFn: () => loadSvg(uri),
    // Disk is the source of truth — once a URL resolves, the inlined
    // text never changes (URLs are content-versioned). Keep it in
    // memory for the session so repeat renders are zero-cost.
    staleTime: Infinity,
    gcTime: 24 * 60 * 60_000,
    // Avatars are best-effort decoration — a transient network blip
    // shouldn't leave a permanent initial-letter glyph in place, but
    // a 4xx is a real "this URL is wrong" signal that won't change
    // with more attempts. Retry on everything else up to 4 times with
    // exponential backoff capped at 4s.
    retry: (failureCount, error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (/avatar fetch 4\d\d/.test(msg)) return false;
      return failureCount < 4;
    },
    retryDelay: (attemptIndex) => Math.min(400 * 2 ** attemptIndex, 4000),
    // Refresh on reconnect AND on app-foreground — both catch the
    // common case where a fetch errored while offline or backgrounded
    // and only succeeds once the user is back.
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });

  if (query.isError || !query.data) {
    // Either still loading (no data yet) or the fetch failed — either
    // way show the initial-letter glyph so the avatar slot is never
    // visually empty.
    return fallback;
  }
  return <SvgXml xml={query.data} width={size} height={size} />;
}

const styles = StyleSheet.create({
  initial: {
    fontWeight: '600',
  },
  wrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});

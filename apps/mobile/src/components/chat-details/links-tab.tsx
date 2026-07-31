import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { openBrowserAsync } from 'expo-web-browser';
import { memo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  flattenLinkPages,
  useChannelLinks,
} from '@/hooks/use-channel-file-list';
import { useLinkPreview } from '@/hooks/use-link-preview';
import { useTheme } from '@/hooks/use-theme';

import { TabEmpty } from './tab-empty';
import { TabFooter } from './tab-footer';

const IMESSAGE_BLUE = '#0A84FF';

interface LinksTabProps {
  channelId: string;
  active: boolean;
}

/**
 * Compact, Telegram-style list of every distinct URL posted to the channel.
 * One row per link: square thumbnail, title, optional description, URL in
 * iOS blue. Tap opens the in-app browser. Falls back to a link glyph when
 * the OG preview has no image (or hasn't loaded yet).
 *
 * Each row fetches its own OG metadata via `useLinkPreview` (Redis-cached
 * server-side, React-Query cached client-side) so opening the tab doesn't
 * fan out an OG fetch for the entire history at once.
 */
export function LinksTab({ channelId, active }: LinksTabProps) {
  const query = useChannelLinks(channelId, active);
  const links = flattenLinkPages(query.data?.pages);

  if (query.isLoading && links.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (links.length === 0) {
    return (
      <TabEmpty
        symbol={{ ios: 'link', android: 'link' }}
        title="No links yet"
        subtitle="URLs shared in this chat will appear here."
      />
    );
  }

  return (
    <View style={styles.list}>
      {links.map((item) => (
        <LinkRow key={`${item.post_id}:${item.url}`} url={item.url} />
      ))}
      <TabFooter
        hasMore={!!query.hasNextPage}
        loading={query.isFetchingNextPage}
        onLoadMore={() => {
          void query.fetchNextPage();
        }}
      />
    </View>
  );
}

interface LinkRowProps {
  url: string;
}

const LinkRow = memo(function LinkRow({ url }: LinkRowProps) {
  const theme = useTheme();
  const preview = useLinkPreview(url);
  const [imageFailed, setImageFailed] = useState(false);

  // Defer rendering until the preview lands. Unfurl failures collapse to
  // null so the list stays tight rather than showing a half-row for a
  // dead URL.
  if (!preview || preview.error) return null;

  const href = preview.canonical_url ?? preview.url;
  const host = safeHost(href);
  const title = preview.title?.trim() || host;
  const description = preview.description?.trim() ?? null;
  const showImage = Boolean(preview.image_url) && !imageFailed;

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${title}`}
      onPress={() => {
        void openBrowserAsync(href).catch(() => {});
      }}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.backgroundElement : 'transparent' },
      ]}>
      <View style={[styles.thumb, { backgroundColor: theme.backgroundElement }]}>
        {showImage ? (
          <Image
            source={{ uri: preview.image_url! }}
            style={styles.thumbImage}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={120}
            accessible={false}
            onError={() => { setImageFailed(true); }}
          />
        ) : (
          <SymbolView
            name="link"
            size={22}
            tintColor={theme.textSecondary}
            resizeMode="scaleAspectFit"
          />
        )}
      </View>
      <View style={styles.text}>
        <Text
          style={[styles.title, { color: theme.text }]}
          numberOfLines={1}>
          {title}
        </Text>
        {description ? (
          <Text
            style={[styles.description, { color: theme.textSecondary }]}
            numberOfLines={2}>
            {description}
          </Text>
        ) : null}
        <Text style={styles.url} numberOfLines={1}>
          {prettyUrl(href)}
        </Text>
      </View>
    </Pressable>
  );
});

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** ``https://youtu.be/abc?si=…`` → ``youtu.be/abc?si=…`` — Telegram-style
 *  display, scheme stripped so the eye lands on the host first. */
function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    const search = u.search;
    return `${u.host.replace(/^www\./, '')}${path}${search}`;
  } catch {
    return url;
  }
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  description: {
    fontSize: 13,
    letterSpacing: -0.1,
    lineHeight: 17,
  },
  list: {
    gap: 2,
  },
  row: {
    alignItems: 'center',
    borderRadius: 10,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  text: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  thumb: {
    alignItems: 'center',
    borderRadius: 10,
    height: 56,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 56,
  },
  thumbImage: {
    height: '100%',
    width: '100%',
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  url: {
    color: IMESSAGE_BLUE,
    fontSize: 12,
    letterSpacing: -0.1,
  },
});

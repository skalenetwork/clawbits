import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { ImageLightbox } from '@/components/chat/image-lightbox';
import { PressableScale } from '@/components/pressable-scale';
import { useTheme } from '@/hooks/use-theme';
import {
  flattenFilePages,
  useChannelFileList,
} from '@/hooks/use-channel-file-list';
import { useIsLargeWindow } from '@/hooks/use-window-size-class';
import type { MmFile } from '@/lib/api';

import { TabEmpty } from './tab-empty';
import { TabFooter } from './tab-footer';

const GRID_GAP = 6;
const GRID_HPAD = 16;

interface MediaTabProps {
  channelId: string;
  /** True when this tab is currently visible. We gate the React Query
   *  fetch on this so the screen doesn't burn an HTTP round trip per
   *  inactive tab on mount. The query stays subscribed once enabled so
   *  switching back is instant. */
  active: boolean;
}

/**
 * Grid of images + videos posted to the channel, newest first.
 *
 * 3 columns on phones, 4 on foldable inner / tablet (≥600dp). Each
 * tile is a 1:1 square so the grid reads as a single visual block; the
 * actual image preserves aspect via ``contentFit="cover"``. Videos get
 * a play-icon overlay + tiny duration chip so they're distinguishable
 * from images at a glance.
 *
 * Taps on an image open the existing ``ImageLightbox`` with all visible
 * images in scope. Taps on a video also open the lightbox, but only
 * with images — video playback would need a different surface (we'd
 * use ``expo-video``) and is deferred to a follow-up. For now the
 * video tile is visual + tappable-as-no-op.
 */
export function MediaTab({ channelId, active }: MediaTabProps) {
  const theme = useTheme();
  const isLarge = useIsLargeWindow();
  const { width: screenWidth } = useWindowDimensions();
  const query = useChannelFileList(channelId, 'media', active);
  const files = flattenFilePages(query.data?.pages);

  const cols = isLarge ? 4 : 3;
  // The grid lives inside the screen's horizontal padding, so subtract
  // both edge insets plus (cols - 1) inter-tile gaps from the screen
  // width to size each tile.
  const tileSize = (screenWidth - GRID_HPAD * 2 - GRID_GAP * (cols - 1)) / cols;

  // ``selected`` doubles as both "is lightbox open" and "which image is
  // it showing" — null = closed.
  const [selected, setSelected] = useState<number | null>(null);

  if (query.isLoading && files.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (files.length === 0) {
    return (
      <TabEmpty
        symbol={{ ios: 'photo.on.rectangle', android: 'photo_library' }}
        title="No media yet"
        subtitle="Images and videos shared in this chat will appear here."
      />
    );
  }

  const imageUrls = files
    .filter((f) => f.content_type.startsWith('image/'))
    .map((f) => f.download_url ?? f.thumbnail_url ?? '')
    .filter((url) => url.length > 0);

  return (
    <View>
      <View style={styles.grid}>
        {files.map((file, idx) => (
          <MediaTile
            key={file.file_id}
            file={file}
            size={tileSize}
            theme={theme}
            onPress={() => {
              if (file.content_type.startsWith('image/')) {
                // Index into ``imageUrls`` matches index into ``files``
                // filtered to images only — count images preceding this
                // one to get the right lightbox start position.
                const imageIdx = files
                  .slice(0, idx)
                  .filter((f) => f.content_type.startsWith('image/')).length;
                setSelected(imageIdx);
              }
            }}
          />
        ))}
      </View>
      <TabFooter
        hasMore={!!query.hasNextPage}
        loading={query.isFetchingNextPage}
        onLoadMore={() => {
          void query.fetchNextPage();
        }}
      />
      <ImageLightbox
        visible={selected !== null}
        imageUrls={imageUrls}
        initialIndex={selected ?? 0}
        onClose={() => setSelected(null)}
      />
    </View>
  );
}

function MediaTile({
  file,
  size,
  theme,
  onPress,
}: {
  file: MmFile;
  size: number;
  theme: ReturnType<typeof useTheme>;
  onPress: () => void;
}) {
  const isVideo = file.content_type.startsWith('video/');
  const previewUrl = file.thumbnail_url ?? file.download_url;

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={file.filename}
      onPress={onPress}
      pressedScale={0.94}
      style={[
        styles.tile,
        {
          backgroundColor: theme.backgroundElement,
          height: size,
          width: size,
        },
      ]}>
      {previewUrl ? (
        <Image
          source={{ uri: previewUrl }}
          style={styles.tileImage}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={120}
        />
      ) : (
        <View style={styles.tileFallback}>
          <SymbolView
            name={{
              ios: isVideo ? 'play.rectangle.fill' : 'photo.fill',
              android: isVideo ? 'play_circle' : 'photo',
            }}
            size={28}
            tintColor={theme.textSecondary}
            weight="medium"
          />
        </View>
      )}
      {isVideo ? (
        <View style={styles.videoOverlay} pointerEvents="none">
          <View style={styles.playChip}>
            <SymbolView
              name={{ ios: 'play.fill', android: 'play_arrow' }}
              size={14}
              tintColor="#FFFFFF"
              weight="bold"
            />
          </View>
          {file.duration_ms != null ? (
            <View style={styles.durationChip}>
              <Text style={styles.durationText}>
                {formatDuration(file.duration_ms)}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </PressableScale>
  );
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  durationChip: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  durationText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  playChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  tile: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  tileFallback: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  tileImage: {
    height: '100%',
    width: '100%',
  },
  videoOverlay: {
    bottom: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 6,
    position: 'absolute',
    right: 6,
  },
});

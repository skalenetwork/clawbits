import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { memo, useMemo } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import type { MmFile } from '@/lib/api';

const MAX_BUBBLE_WIDTH_FRAC = 0.78;
const GRID_GAP = 2;
// Corner radius for the single full-bleed image; matches the bubble's
// ``baseRadius`` so an image-only bubble reads as one rounded card.
const IMAGE_RADIUS = 18;
// Clamp the displayed aspect of a single image so a too-tall or too-wide one is
// CROPPED to a sensible box (the Image fills it with contentFit:'cover')
// instead of shrinking to show the whole picture. Images within the range
// render in full.
const MIN_IMAGE_ASPECT = 0.7; // tallest box ≈ 5:7 — taller images crop top/bottom
const MAX_IMAGE_ASPECT = 1.9; // widest box ≈ 1.9:1 — wider images crop the sides

/** Prefer the server thumbnail for the in-bubble render (smaller, faster to
 *  decode, and reinforces the cropped-thumbnail intent); the lightbox opens the
 *  full-res ``download_url`` separately. */
function imageSource(f: MmFile) {
  const uri = f.thumbnail_url ?? f.download_url;
  return uri ? { uri } : undefined;
}

interface BubbleImageGridProps {
  images: MmFile[];
  /** Tap on an image — opens the lightbox at the tapped index. */
  onImagePress?: (index: number, imageUrls: string[]) => void;
}

/**
 * Full-bleed image grid rendered at the top of a message bubble.
 *
 * Images are plain RN views (no per-image native menu) so they scroll in
 * lockstep with the bubble and inherit its rounded clip; long-press is handled
 * by the bubble-level menu (``MessageBubbleMenu``). Telegram-style: a single
 * image fills the bubble's top edge inside its own rounded/clipped box, pairs
 * sit side-by-side, three+ render as a 2×2 grid with a "+N" overlay on the
 * fourth tile.
 */
export const BubbleImageGrid = memo(function BubbleImageGrid({
  images,
  onImagePress,
}: BubbleImageGridProps) {
  const { width: screenWidth } = useWindowDimensions();
  const bubbleWidth = Math.min(360, screenWidth * MAX_BUBBLE_WIDTH_FRAC);

  // Lightbox always opens the full-resolution asset.
  const imageUrls = useMemo(
    () => images.map((f) => f.download_url ?? '').filter((u) => u.length > 0),
    [images],
  );

  if (images.length === 0) return null;

  const fire = (index: number) => onImagePress?.(index, imageUrls);

  if (images.length === 1) {
    const f = images[0];
    if (!f) return null;
    // Backend now probes ``width``/``height`` on confirm + has a one-shot
    // backfill for legacy rows, so the fallback path is exceptional. 1:1 is the
    // neutral "I don't know" — doesn't pretend to be a photo (4:3) or a banner
    // (16:9), so the eventual swap to real dimensions is a smaller surprise.
    // Clamp the aspect so a too-tall or too-wide image is CROPPED to a sensible
    // box (the Image fills it with contentFit:'cover') rather than shrinking to
    // show the whole picture small. Images within the range render in full. The
    // box is always the full bubble width; only the height (hence crop) varies.
    const rawAspect = f.width && f.height ? f.width / f.height : 1;
    const aspect = Math.min(MAX_IMAGE_ASPECT, Math.max(MIN_IMAGE_ASPECT, rawAspect));
    const w = bubbleWidth;
    const h = bubbleWidth / aspect;
    return (
      <View style={[styles.singleImageWrap, { width: w, height: h }]}>
        <Pressable onPress={() => fire(0)} style={styles.imageFill}>
          <Image
            source={imageSource(f)}
            style={styles.imageFill}
            contentFit="cover"
            // Match placeholder fit to content fit so the bytes simply colour
            // the same box that was reserved (no hop when they land).
            placeholderContentFit="cover"
            transition={120}
          />
        </Pressable>
      </View>
    );
  }

  if (images.length === 2) {
    const tile = (bubbleWidth - GRID_GAP) / 2;
    return (
      <View style={[styles.gridRow, { width: bubbleWidth, height: tile }]}>
        {images.map((f, i) => (
          <Pressable
            key={f.file_id}
            onPress={() => fire(i)}
            style={[styles.gridTile, { width: tile, height: tile }]}>
            <Image
              source={imageSource(f)}
              style={styles.imageFill}
              contentFit="cover"
              placeholderContentFit="cover"
              transition={120}
            />
          </Pressable>
        ))}
      </View>
    );
  }

  // 3+ — 2x2 grid; last tile shows +N overlay if more than 4. The tiles already
  // clip (``gridTile.overflow:'hidden'``) and the bubble rounds the outer
  // corners, so no per-tile radius is needed.
  const tile = (bubbleWidth - GRID_GAP) / 2;
  const visible = images.slice(0, 4);
  const extra = Math.max(0, images.length - 4);
  const gridHeight = 2 * tile + GRID_GAP;
  return (
    <View style={[styles.gridWrap, { width: bubbleWidth, height: gridHeight }]}>
      {visible.map((f, i) => {
        const isLast = i === 3 && extra > 0;
        return (
          <Pressable
            key={f.file_id}
            onPress={() => fire(i)}
            style={[styles.gridTile, { width: tile, height: tile }]}>
            <Image
              source={imageSource(f)}
              style={styles.imageFill}
              contentFit="cover"
              placeholderContentFit="cover"
              transition={120}
            />
            {isLast ? (
              <View style={styles.moreOverlay}>
                <Text style={styles.moreText}>+{extra}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
});

interface BubbleFileListProps {
  files: MmFile[];
  isOutgoing: boolean;
}

/**
 * Stack of non-image attachment cards rendered INSIDE the bubble's padded
 * inner column. The card background is a subtle overlay tone of the bubble
 * (translucent black on incoming, translucent white on outgoing) instead of
 * the standalone-tile ``backgroundElement`` — otherwise the cards read as
 * "tiles on top of tiles".
 *
 * The fixed ``width`` is load-bearing: when the post is file-only (no caption,
 * no image), the bubble has no other content to size against, and ``flex: 1``
 * on the file row's meta column collapses to zero — the filename disappears
 * and the tap target shrinks to the icon. Setting an explicit width here lets
 * the bubble grow to a sensible size and the meta column expand.
 */
export const BubbleFileList = memo(function BubbleFileList({
  files,
  isOutgoing,
}: BubbleFileListProps) {
  const { width: screenWidth } = useWindowDimensions();
  // The bubble's ``maxWidth`` is 78% of screen, and the padded inner column
  // subtracts 14px of horizontal padding on each side. Match that here so the
  // cards fill the bubble cleanly without forcing it wider than text bubbles.
  const cardWidth = Math.min(360, screenWidth * MAX_BUBBLE_WIDTH_FRAC) - 28;
  if (files.length === 0) return null;
  return (
    <View style={[styles.fileList, { width: cardWidth }]}>
      {files.map((f) => (
        <FileCard key={f.file_id} file={f} isOutgoing={isOutgoing} />
      ))}
    </View>
  );
});

function FileCard({ file, isOutgoing }: { file: MmFile; isOutgoing: boolean }) {
  const theme = useTheme();
  const isVideo = file.content_type.startsWith('video/');
  const isAudio = file.content_type.startsWith('audio/');
  const icon = isVideo ? 'play.rectangle.fill' : isAudio ? 'waveform' : 'doc.fill';

  // On-bubble tones: subtle inset card. Outgoing bubbles are the iOS blue, so a
  // translucent white overlay reads as "lighter blue". For incoming bubbles we
  // mirror with translucent black.
  const cardBg = isOutgoing ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.06)';
  const primaryColor = isOutgoing ? '#FFFFFF' : theme.text;
  const secondaryColor = isOutgoing ? 'rgba(255,255,255,0.75)' : theme.textSecondary;

  const onPress = async () => {
    if (file.download_url) {
      void Linking.openURL(file.download_url).catch(() => {});
    }
  };

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.fileCard,
        { backgroundColor: cardBg, opacity: pressed ? 0.85 : 1 },
      ]}>
      <SymbolView
        name={{ ios: icon, android: 'description' }}
        size={24}
        tintColor={secondaryColor}
        weight="medium"
        style={styles.fileIcon}
      />
      <View style={styles.fileMeta}>
        <Text style={[styles.fileName, { color: primaryColor }]} numberOfLines={1}>
          {file.filename}
        </Text>
        <Text style={[styles.fileSize, { color: secondaryColor }]}>
          {formatBytes(file.size_bytes)}
        </Text>
      </View>
      <SymbolView
        name={{ ios: 'arrow.down.circle', android: 'download' }}
        size={18}
        tintColor={secondaryColor}
        weight="medium"
      />
    </Pressable>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const styles = StyleSheet.create({
  fileCard: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  fileIcon: {
    height: 24,
    width: 24,
  },
  fileList: {
    gap: 6,
  },
  fileMeta: {
    flex: 1,
    gap: 1,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '600',
  },
  fileSize: {
    fontSize: 12,
  },
  gridRow: {
    flexDirection: 'row',
    gap: GRID_GAP,
  },
  gridTile: {
    backgroundColor: '#00000022',
    overflow: 'hidden',
  },
  gridWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  imageFill: {
    height: '100%',
    width: '100%',
  },
  moreOverlay: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  moreText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
  },
  singleImageWrap: {
    alignSelf: 'center',
    borderRadius: IMAGE_RADIUS,
    overflow: 'hidden',
  },
});

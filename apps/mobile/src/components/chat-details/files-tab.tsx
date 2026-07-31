import { SymbolView } from 'expo-symbols';
import { openBrowserAsync } from 'expo-web-browser';
import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { PressableScale } from '@/components/pressable-scale';
import { useTheme } from '@/hooks/use-theme';
import {
  flattenFilePages,
  useChannelFileList,
} from '@/hooks/use-channel-file-list';
import { getFileDownloadUrl, type MmFile } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

import { TabEmpty } from './tab-empty';
import { TabFooter } from './tab-footer';

interface FilesTabProps {
  channelId: string;
  active: boolean;
}

/**
 * Vertical list of non-image / non-video attachments — PDFs, audio,
 * arbitrary uploads. Each row is a tappable card that opens the file
 * via the system browser (presigned URL — server-side gated by channel
 * membership; the URL itself is single-shot-friendly with a ~1h TTL).
 *
 * For PDFs and most application/* content types the in-app browser
 * (``openBrowserAsync``) renders the file directly; for audio it
 * triggers the native player. We don't try to detect MIME type and
 * pick a viewer — the OS makes a better choice than we would.
 */
export function FilesTab({ channelId, active }: FilesTabProps) {
  const query = useChannelFileList(channelId, 'file', active);
  const files = flattenFilePages(query.data?.pages);

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
        symbol={{ ios: 'doc.text', android: 'description' }}
        title="No files yet"
        subtitle="Documents and other uploads shared in this chat will appear here."
      />
    );
  }

  return (
    <View>
      {files.map((file) => (
        <FileRow key={file.file_id} file={file} />
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

function FileRow({ file }: { file: MmFile }) {
  const theme = useTheme();
  const { token } = useAuth();
  const isAudio = file.content_type.startsWith('audio/');
  const isPdf = file.content_type === 'application/pdf';
  // SF Symbol picker — matches the bubble-attachments file-card idiom
  // so the same file looks the same wherever it appears.
  const iosIcon = isAudio
    ? 'waveform'
    : isPdf
      ? 'doc.richtext.fill'
      : 'doc.fill';

  const openFile = async () => {
    // The endpoint inlines ``download_url`` only for images; for files
    // we need to request a fresh presigned GET URL. Fall back to the
    // baked URL if for some reason the request fails (unlikely — the
    // member check is already passed because the file is in this list).
    let url = file.download_url;
    if (!url) {
      try {
        const result = await getFileDownloadUrl(token, file.file_id);
        url = result.url;
      } catch {
        return;
      }
    }
    if (!url) return;
    // ``openBrowserAsync`` handles PDFs / audio / general media better
    // than ``Linking.openURL`` — it keeps the user in-app and uses the
    // system viewer for the content type. For exotic types (zip,
    // tarball) where the browser would just download, fall back to
    // ``Linking.openURL`` which lets the OS pick.
    try {
      await openBrowserAsync(url);
    } catch {
      await Linking.openURL(url).catch(() => {});
    }
  };

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={file.filename}
      onPress={() => {
        void openFile();
      }}
      pressedScale={0.97}
      style={[
        styles.row,
        { backgroundColor: theme.backgroundElement },
      ]}>
      <View
        style={[
          styles.iconTile,
          { backgroundColor: theme.backgroundSelected },
        ]}>
        <SymbolView
          name={{ ios: iosIcon, android: 'description' }}
          size={22}
          tintColor={theme.text}
          weight="medium"
        />
      </View>
      <View style={styles.meta}>
        <Text
          style={[styles.filename, { color: theme.text }]}
          numberOfLines={1}>
          {file.filename}
        </Text>
        <Text
          style={[styles.subtitle, { color: theme.textSecondary }]}
          numberOfLines={1}>
          {formatBytes(file.size_bytes)} · {formatRelativeDate(file.created_at)}
        </Text>
      </View>
      <SymbolView
        name={{ ios: 'arrow.down.circle', android: 'download' }}
        size={20}
        tintColor={theme.textSecondary}
        weight="medium"
      />
    </PressableScale>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const day = 86_400_000;
  if (diffMs < day) return 'Today';
  if (diffMs < 2 * day) return 'Yesterday';
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)} days ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  filename: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.1,
  },
  iconTile: {
    alignItems: 'center',
    borderRadius: 12,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  meta: {
    flex: 1,
    gap: 2,
    marginHorizontal: 12,
  },
  row: {
    alignItems: 'center',
    borderRadius: 16,
    flexDirection: 'row',
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  subtitle: {
    fontSize: 12,
    letterSpacing: -0.05,
  },
});

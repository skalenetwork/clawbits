import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { memo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import type { PendingAttachment } from '@/hooks/use-channel-attachments';

interface PendingAttachmentsProps {
  attachments: PendingAttachment[];
  onRemove: (tempId: string) => void;
}

export const PendingAttachments = memo(function PendingAttachments({
  attachments,
  onRemove,
}: PendingAttachmentsProps) {
  if (attachments.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}>
      {attachments.map((att) => (
        <PendingTile key={att.tempId} attachment={att} onRemove={onRemove} />
      ))}
    </ScrollView>
  );
});

function PendingTile({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: (tempId: string) => void;
}) {
  const theme = useTheme();
  const isImage = attachment.asset.contentType.startsWith('image/');
  const isUploading = attachment.status === 'preparing' || attachment.status === 'uploading';
  const isConfirming = attachment.status === 'confirming';
  const isFailed = attachment.status === 'failed';

  return (
    <View style={styles.tile}>
      <View style={[styles.thumb, { backgroundColor: theme.backgroundElement }]}>
        {isImage ? (
          <Image
            source={{ uri: attachment.asset.uri }}
            style={styles.image}
            contentFit="cover"
          />
        ) : (
          <View style={styles.fileTile}>
            <SymbolView
              name={{ ios: 'doc.fill', android: 'description' }}
              size={28}
              tintColor={theme.textSecondary}
              weight="medium"
              style={styles.fileIcon}
            />
            <Text style={[styles.fileName, { color: theme.text }]} numberOfLines={2}>
              {attachment.asset.filename}
            </Text>
          </View>
        )}
        {isUploading || isConfirming ? (
          <View style={styles.overlay}>
            <ActivityIndicator color="#FFFFFF" />
            {isUploading ? (
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.round(attachment.progress * 100)}%` },
                  ]}
                />
              </View>
            ) : null}
          </View>
        ) : null}
        {isFailed ? (
          <View style={[styles.overlay, styles.failOverlay]}>
            <SymbolView
              name={{ ios: 'exclamationmark.circle.fill', android: 'error' }}
              size={20}
              tintColor="#FFFFFF"
              weight="bold"
            />
          </View>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Remove attachment"
        onPress={() => onRemove(attachment.tempId)}
        hitSlop={6}
        style={styles.removeButton}>
        <SymbolView
          name={{ ios: 'xmark.circle.fill', android: 'cancel' }}
          size={22}
          tintColor="#FFFFFF"
          weight="bold"
        />
      </Pressable>
    </View>
  );
}

const TILE = 72;

const styles = StyleSheet.create({
  failOverlay: {
    backgroundColor: 'rgba(220,80,70,0.7)',
  },
  fileIcon: {
    height: 28,
    width: 28,
  },
  fileName: {
    fontSize: 10,
    fontWeight: '600',
    paddingHorizontal: 4,
    textAlign: 'center',
  },
  fileTile: {
    alignItems: 'center',
    flex: 1,
    gap: 4,
    justifyContent: 'center',
    padding: 4,
  },
  image: {
    height: TILE,
    width: TILE,
  },
  overlay: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 12,
    bottom: 0,
    gap: 6,
    justifyContent: 'center',
    left: 0,
    paddingHorizontal: 8,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  progressFill: {
    backgroundColor: '#FFFFFF',
    height: 3,
  },
  progressTrack: {
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 999,
    height: 3,
    overflow: 'hidden',
    width: TILE - 16,
  },
  removeButton: {
    position: 'absolute',
    right: -6,
    top: -6,
  },
  row: {
    gap: 8,
    paddingBottom: 8,
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  thumb: {
    borderRadius: 12,
    height: TILE,
    overflow: 'hidden',
    width: TILE,
  },
  tile: {
    height: TILE,
    width: TILE,
  },
});

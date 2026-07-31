import { SymbolView } from 'expo-symbols';
import { DynamicColorIOS, Platform, StyleSheet, Text, View } from 'react-native';

import { ChannelAvatar } from '@/components/channel-avatar';
import type { MmChannel } from '@/lib/api';
import { formatChannelTitle, formatRelativeTime } from '@/lib/formatting';
import { useTheme } from '@/hooks/use-theme';

const SYSTEM_RED =
  Platform.OS === 'ios'
    ? DynamicColorIOS({ light: '#FF3B30', dark: '#FF453A' })
    : '#FF3B30';

interface ChannelRowProps {
  channel: MmChannel;
}

export function ChannelRow({ channel }: ChannelRowProps) {
  const theme = useTheme();
  const title = formatChannelTitle(channel.display_name ?? channel.name);
  const previewText = channel.last_message_text ?? '';
  const attachmentCount = channel.last_message_attachment_count ?? 0;
  const hasAttachment = attachmentCount > 0;
  // Compose the preview body — attachment-only messages get a synthetic
  // "Attachment" / "N attachments" label so the row still has visible
  // content; messages with both text and files keep the text.
  const previewBody = previewText
    ? previewText
    : hasAttachment
      ? attachmentCount === 1
        ? 'Attachment'
        : `${attachmentCount} attachments`
      : 'No messages yet';
  const timestamp = formatRelativeTime(channel.last_message_at ?? channel.created_at);
  const isDirect = channel.channel_type === 'direct';
  const senderName = channel.last_message_author_display_name?.trim() || null;
  const showSenderLine = !isDirect && senderName != null;

  return (
    <View style={styles.row}>
      <ChannelAvatar
        channel={channel}
        size={58}
        style={styles.glyph}
      />
      <View style={styles.content}>
        <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
          {title}
        </Text>
        {showSenderLine ? (
          <>
            <Text style={[styles.sender, { color: theme.text }]} numberOfLines={1}>
              {senderName}
            </Text>
            <PreviewLine
              text={previewBody}
              hasAttachment={hasAttachment}
              color={theme.textSecondary}
              numberOfLines={1}
            />
          </>
        ) : (
          <PreviewLine
            text={previewBody}
            hasAttachment={hasAttachment}
            color={theme.textSecondary}
            numberOfLines={2}
          />
        )}
      </View>
      <View style={styles.rightCol}>
        <Text style={[styles.time, { color: theme.textSecondary }]} numberOfLines={1}>
          {timestamp}
        </Text>
        {channel.unread_count ? (
          <View style={[styles.badge, { backgroundColor: SYSTEM_RED }]}>
            <Text style={styles.badgeText}>{channel.unread_count}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function PreviewLine({
  text,
  hasAttachment,
  color,
  numberOfLines,
}: {
  text: string;
  hasAttachment: boolean;
  color: string;
  numberOfLines: number;
}) {
  return (
    <View style={styles.previewRow}>
      {hasAttachment ? (
        <SymbolView
          name={{ ios: 'paperclip', android: 'attach_file' }}
          tintColor={color}
          size={12}
          weight="medium"
          style={styles.paperclip}
        />
      ) : null}
      <Text style={[styles.preview, { color }]} numberOfLines={numberOfLines}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    borderRadius: 999,
    minWidth: 22,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  content: {
    flex: 1,
    gap: 2,
    minWidth: 0,
    paddingRight: 72,
  },
  glyph: {
    borderRadius: 15,
  },
  paperclip: {
    height: 12,
    width: 12,
  },
  preview: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  previewRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  rightCol: {
    alignItems: 'flex-end',
    flexDirection: 'column',
    gap: 10,
    position: 'absolute',
    right: 0,
    top: 12,
    width: 60,
  },
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 0,
    paddingVertical: 10,
  },
  sender: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  time: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    paddingTop: 2,
  },
});

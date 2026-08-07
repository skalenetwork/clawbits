import { SymbolView } from 'expo-symbols';
import { memo, useEffect, useMemo } from 'react';
import {
  DynamicColorIOS,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Avatar } from '@/components/avatar';
import {
  BubbleFileList,
  BubbleImageGrid,
} from '@/components/chat/bubble-attachments';
import { BubbleReactions } from '@/components/chat/bubble-reactions';
import { LinkPreviewCard } from '@/components/chat/link-preview-card';
import { MessageMarkdown } from '@/components/chat/message-markdown';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import type { MessageRow } from '@/lib/chat-grouping';
import { matchAdminCommandText, type AdminCommandMatch } from '@/lib/admin-commands';
import { extractUrls } from '@/lib/extract-urls';
import { quotedBodyText } from '@/lib/formatting';

const IMESSAGE_BLUE = '#0A84FF';
const INCOMING_LIGHT = '#E9E9EB';
const INCOMING_DARK = '#262628';

// Channel-only avatar gutter on incoming bubbles. Sits in the cleared
// left padding of the row, anchored to the bottom — only rendered on
// the last bubble of a streak so back-to-back messages from the same
// sender share one avatar. In DMs the gutter is skipped entirely so
// incoming bubbles flow flush against the screen's left padding,
// iMessage-style.
const AVATAR_SIZE = 28;
const AVATAR_GAP = 4;
const AVATAR_GUTTER = AVATAR_SIZE + AVATAR_GAP;

const SYSTEM_RED =
  Platform.OS === 'ios'
    ? DynamicColorIOS({ light: '#FF3B30', dark: '#FF453A' })
    : '#FF3B30';

interface MessageBubbleProps {
  row: MessageRow;
  onReactionPress?: (emoji: string) => void;
  onImagePress?: (index: number, imageUrls: string[]) => void;
  /** Tap on the quoted parent block — scrolls to the referenced post. */
  onParentPress?: (parentPostId: number) => void;
  /** Tap on the failed-send (!) icon — offers resend / discard. Only set
   *  for failed outgoing posts; deliberately excluded from the props memo
   *  (it closes over stable handlers, so a stale closure is still correct). */
  onRetry?: () => void;
  /** Briefly flash this bubble — set when a search result or quoted-reply
   *  jump lands on it, then cleared by the parent after ~1.6s. */
  highlighted?: boolean;
}

/** Field-equality memo for the bubble. ``buildChatRows`` produces a
 *  NEW ``MessageRow`` object on every render (even when the underlying
 *  posts haven't changed), so React's default reference-based ``memo``
 *  treats every parent re-render as a prop change and re-renders every
 *  visible bubble. That's the dominant cost during SSE storms or
 *  scroll-driven row remounts.
 *
 *  We instead check the fields that actually drive rendering:
 *
 *   - ``row.post`` by reference (React Query preserves identity for
 *     unchanged posts; a token-stream patch produces a new reference,
 *     which is what we *want* to trigger a re-render).
 *   - The row-level booleans that change when neighbouring posts shift
 *     (streak grouping, sender-name visibility, avatar gutter,
 *     read-receipt status).
 *   - The handler refs (they're stable via useCallback in the parent
 *     screen, so reference-equality is sufficient).
 *
 *  If any of these are equal pair-wise, we skip the render. Net win is
 *  huge during a streaming agent reply or a multi-second scroll-up:
 *  only the one or two bubbles whose ``post`` actually changed
 *  re-render; the other 30+ visible bubbles stay put. */
function areBubblePropsEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  if (prev.row.post !== next.row.post) return false;
  if (prev.row.isFirstInStreak !== next.row.isFirstInStreak) return false;
  if (prev.row.isLastInStreak !== next.row.isLastInStreak) return false;
  if (prev.row.showSenderName !== next.row.showSenderName) return false;
  if (prev.row.showAvatar !== next.row.showAvatar) return false;
  if (prev.row.isOutgoing !== next.row.isOutgoing) return false;
  if (prev.row.isDirect !== next.row.isDirect) return false;
  if (prev.row.isAdminCommand !== next.row.isAdminCommand) return false;
  if (prev.row.viewerHumanId !== next.row.viewerHumanId) return false;
  if (prev.row.outgoingStatus !== next.row.outgoingStatus) return false;
  if (prev.onReactionPress !== next.onReactionPress) return false;
  if (prev.onImagePress !== next.onImagePress) return false;
  if (prev.onParentPress !== next.onParentPress) return false;
  if (prev.highlighted !== next.highlighted) return false;
  return true;
}

export const MessageBubble = memo(function MessageBubble({
  row,
  onReactionPress,
  onImagePress,
  onParentPress,
  onRetry,
  highlighted,
}: MessageBubbleProps) {
  const theme = useTheme();
  const scheme = useColorScheme();

  // Transient flash when a search/quoted-reply jump lands on this bubble:
  // a quick fade-in then a slow fade-out of a tinted row overlay.
  const flash = useSharedValue(0);
  useEffect(() => {
    if (highlighted) {
      flash.value = withSequence(
        withTiming(1, { duration: 160 }),
        withTiming(0, { duration: 1300 }),
      );
    }
  }, [highlighted, flash]);
  const flashStyle = useAnimatedStyle(() => ({ opacity: flash.value }));
  const flashColor = scheme === 'dark' ? 'rgba(10,132,255,0.22)' : 'rgba(10,132,255,0.12)';
  const {
    post,
    isOutgoing,
    isFirstInStreak,
    isLastInStreak,
    showSenderName,
    showAvatar,
    isDirect,
    isAdminCommand,
    viewerHumanId,
  } = row;
  const isFailed = post._failed === true;
  const isPending = post.status === 'streaming' && post.post_id < 0 && !isFailed;
  // Any in-flight streaming state — covers the local optimistic temp
  // (``isPending``) and the agent token stream (server-assigned id with
  // status='streaming'). Both skip the full markdown pipeline; the
  // agent variant also gets a blinking caret to signal liveness.
  const isStreaming = post.status === 'streaming' && !isFailed;
  const isAgentStream = isStreaming && post.post_id > 0;
  // Pick the single URL to unfurl, with the server-embedded preview as
  // the canonical source. Order of preference:
  //
  //   1. ``post.link_preview`` — set when the server resolved the unfurl
  //      synchronously on publish/edit. Renders the card with no network
  //      fetch + no skeleton swap.
  //   2. First URL in the message body — only used as a fallback for
  //      legacy posts predating server-side embedding (or when the
  //      server-side fetch returned no usable fields and persisted
  //      nothing). Async fetch path with the same height shift the web
  //      app used to have, but bounded to the legacy corpus.
  //
  // Skip both on optimistic pending posts — the URL might still change
  // before the server echoes back, the server hasn't resolved it yet,
  // and a flashing card during the round-trip would feel jumpy.
  // ``useMemo`` keeps the regex out of the hot path during SSE bursts;
  // ``message`` is the only input that changes per re-render.
  const fallbackPreviewUrl = useMemo(() => {
    if (isPending) return null;
    if (post.link_preview) return null;
    return extractUrls(post.message)[0] ?? null;
  }, [isPending, post.link_preview, post.message]);
  const embeddedPreview = !isPending ? post.link_preview ?? null : null;

  const incomingBg = scheme === 'dark' ? INCOMING_DARK : INCOMING_LIGHT;
  const adminBg = scheme === 'dark' ? 'rgba(10,132,255,0.20)' : 'rgba(10,132,255,0.10)';
  const adminBorderColor = scheme === 'dark'
    ? 'rgba(10,132,255,0.35)'
    : 'rgba(10,132,255,0.25)';
  const bubbleBg = isAdminCommand ? adminBg : isOutgoing ? IMESSAGE_BLUE : incomingBg;
  const textColor = isAdminCommand ? IMESSAGE_BLUE : isOutgoing ? '#FFFFFF' : theme.text;

  const tailRadius = 5;
  const baseRadius = 18;
  const tailOnLeft = !isOutgoing && isLastInStreak;
  const tailOnRight = isOutgoing && isLastInStreak;

  const bubbleRadiusStyle = {
    borderTopLeftRadius: baseRadius,
    borderTopRightRadius: baseRadius,
    borderBottomLeftRadius: tailOnLeft ? tailRadius : baseRadius,
    borderBottomRightRadius: tailOnRight ? tailRadius : baseRadius,
  };

  const files = post.files ?? [];
  const images = files.filter((f) => f.content_type.startsWith('image/'));
  const otherFiles = files.filter((f) => !f.content_type.startsWith('image/'));
  const hasImages = images.length > 0;
  const hasOtherFiles = otherFiles.length > 0;
  const hasText = post.message.length > 0;
  const reactions = post.reactions ?? [];
  const hasReactions = reactions.length > 0;
  const hasParentQuote = post.parent_preview != null;
  const adminCommand = isAdminCommand ? matchAdminCommandText(post.message) : null;

  // The padded inner column carries every visual element that isn't
  // full-bleed (sender name, text, file cards, reactions). When the
  // post is image-only — no caption, no extra files, no reactions —
  // we skip it entirely so the bubble visually IS the image.
  const hasPaddedContent = showSenderName || hasText || hasOtherFiles || hasReactions;

  // Channels keep the 32px left gutter on every incoming row so streak
  // continuations align with the avatar'd last bubble. DMs collapse
  // the gutter — incoming and outgoing both flow flush to the row's
  // screen padding.
  const incomingPaddingLeft = isDirect ? 12 : 12 + AVATAR_GUTTER;

  return (
    <View
      style={[
        styles.row,
        isOutgoing
          ? styles.rowOutgoing
          : { alignItems: 'flex-start', paddingLeft: incomingPaddingLeft },
        isFirstInStreak ? styles.rowFirst : styles.rowTight,
        isLastInStreak ? styles.rowLast : null,
      ]}>
      <Animated.View
        pointerEvents="none"
        style={[styles.flashOverlay, { backgroundColor: flashColor }, flashStyle]}
      />
      {showAvatar ? (
        <View style={styles.avatarSlot} pointerEvents="none">
          <Avatar
            uri={post.avatar?.url}
            name={post.poster_display_name}
            size={AVATAR_SIZE}
            framed={false}
            style={styles.avatarCircle}
          />
        </View>
      ) : null}

      <View style={styles.bubbleRow}>
        {isFailed && isOutgoing ? (
          <Pressable
            style={styles.failIcon}
            onPress={onRetry}
            disabled={!onRetry}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Message not sent. Tap to resend or delete.">
            <SymbolView
              name={{ ios: 'exclamationmark.circle.fill', android: 'error' }}
              size={20}
              tintColor={SYSTEM_RED}
              weight="bold"
            />
          </Pressable>
        ) : null}
        <View
          style={[
            styles.bubble,
            { backgroundColor: bubbleBg },
            bubbleRadiusStyle,
            isAdminCommand
              ? [styles.adminBubble, { borderColor: adminBorderColor }]
              : null,
            isPending ? styles.bubblePending : null,
          ]}>
          {hasParentQuote && post.parent_preview ? (
            <ParentQuote
              preview={post.parent_preview}
              isOutgoing={isOutgoing}
              onPress={onParentPress}
            />
          ) : null}

          {hasImages ? (
            <BubbleImageGrid images={images} onImagePress={onImagePress} />
          ) : null}

          {hasPaddedContent ? (
            <View style={styles.paddedInner}>
              {showSenderName && post.poster_display_name ? (
                <Text
                  style={[
                    styles.sender,
                    {
                      color: isOutgoing
                        ? 'rgba(255,255,255,0.85)'
                        : theme.textSecondary,
                    },
                  ]}
                  numberOfLines={1}>
                  {post.poster_display_name}
                </Text>
              ) : null}
              {hasText ? (
                adminCommand ? (
                  <AdminCommandMessage command={adminCommand} />
                ) : isStreaming ? (
                  // Skip the markdown pipeline while the body is still
                  // growing. ``useMarkdown`` re-parses the entire string
                  // on every render, which costs O(30 parses/sec) during
                  // a fast agent reply and stutters on older devices.
                  // Plain text + a blinking caret tracks the stream
                  // cheaply; the bubble switches back to full markdown
                  // when the status flips to ``published``. Same
                  // trade-off the web ``DraftBody`` makes — live links
                  // and mentions stay literal until the message
                  // finalizes a moment later.
                  <StreamingTextBody
                    text={post.message}
                    color={textColor}
                    showCaret={isAgentStream}
                  />
                ) : (
                  <MessageMarkdown
                    text={post.message}
                    color={textColor}
                    codeBackground={
                      isOutgoing ? 'rgba(0,0,0,0.18)' : theme.backgroundSelected
                    }
                    linkColor={isOutgoing ? '#FFFFFF' : IMESSAGE_BLUE}
                  />
                )
              ) : null}
              {hasOtherFiles ? (
                <BubbleFileList files={otherFiles} isOutgoing={isOutgoing} />
              ) : null}
              {hasReactions ? (
                <BubbleReactions
                  reactions={reactions}
                  viewerHumanId={viewerHumanId}
                  isOutgoing={isOutgoing}
                  onPress={onReactionPress}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      </View>

      {embeddedPreview ? (
        <LinkPreviewCard embedded={embeddedPreview} isOutgoing={isOutgoing} />
      ) : fallbackPreviewUrl ? (
        <LinkPreviewCard url={fallbackPreviewUrl} isOutgoing={isOutgoing} />
      ) : null}

      {row.outgoingStatus ? (
        <Text
          style={[styles.status, { color: theme.textSecondary }]}
          accessibilityLabel={`Message ${row.outgoingStatus}`}>
          {row.outgoingStatus === 'sending'
            ? 'Sending…'
            : row.outgoingStatus === 'read'
              ? 'Read'
              : 'Delivered'}
        </Text>
      ) : null}
    </View>
  );
}, areBubblePropsEqual);

function AdminCommandMessage({ command }: { command: AdminCommandMatch }) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const chipBg = scheme === 'dark' ? 'rgba(10,132,255,0.24)' : 'rgba(10,132,255,0.14)';
  const secondary = scheme === 'dark' ? 'rgba(180,215,255,0.82)' : theme.textSecondary;
  return (
    <View style={styles.adminCommandRow}>
      <View style={[styles.adminCommandGlyph, { backgroundColor: chipBg }]}>
        <Text style={styles.adminCommandGlyphText}>/</Text>
      </View>
      <View style={styles.adminCommandCopy}>
        <Text style={styles.adminCommandText}>{command.command}</Text>
        <Text style={[styles.adminCommandDescription, { color: secondary }]}>
          {command.description}
        </Text>
      </View>
    </View>
  );
}

interface ParentQuoteProps {
  preview: NonNullable<MessageRow['post']['parent_preview']>;
  isOutgoing: boolean;
  onPress?: (parentPostId: number) => void;
}

/**
 * Quoted reply preview rendered AT THE TOP OF THE BUBBLE (Telegram-
 * style). Full-bleed across the bubble width with a coloured left bar
 * accent. The bubble's ``overflow: hidden`` clips it to whichever top
 * corners the bubble currently has — including the streak's sharp-tail
 * corner.
 */
function ParentQuote({ preview, isOutgoing, onPress }: ParentQuoteProps) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const removed = preview.status === 'rejected';
  const author =
    preview.poster_display_name ??
    preview.agent_id ??
    (preview.human_id != null ? `User ${preview.human_id}` : 'Unknown');
  // An attachment-only parent has no text to quote — label it from the
  // file count rather than leaving the excerpt line blank.
  const excerpt = removed
    ? 'Original message removed'
    : quotedBodyText(preview.message_excerpt, preview.attachment_count ?? 0);

  // The quote sits inside the bubble; tone it as a darker/lighter
  // overlay on the bubble's own bg so it reads as a nested zone.
  const quoteBg = isOutgoing
    ? 'rgba(0,0,0,0.18)'
    : scheme === 'dark'
      ? 'rgba(255,255,255,0.08)'
      : 'rgba(0,0,0,0.06)';
  const accent = isOutgoing ? '#FFFFFF' : IMESSAGE_BLUE;
  const authorColor = isOutgoing ? '#FFFFFF' : theme.text;
  const excerptColor = isOutgoing ? 'rgba(255,255,255,0.85)' : theme.textSecondary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Reply to ${author}`}
      onPress={() => onPress?.(preview.post_id)}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.quote,
        { backgroundColor: quoteBg },
        pressed && onPress ? styles.quotePressed : null,
      ]}>
      <View style={[styles.quoteAccent, { backgroundColor: accent }]} />
      <View style={styles.quoteBody}>
        <Text style={[styles.quoteAuthor, { color: authorColor }]} numberOfLines={1}>
          {author}
        </Text>
        <Text
          style={[
            styles.quoteExcerpt,
            { color: excerptColor },
            removed && styles.quoteRemoved,
          ]}
          numberOfLines={1}>
          {excerpt}
        </Text>
      </View>
    </Pressable>
  );
}

/** Plain-text body for streaming messages. Bypasses the markdown
 *  pipeline so token-by-token updates don't re-parse the whole string
 *  per keystroke. ``showCaret`` adds a pulsing block caret after the
 *  text — only for the server-driven agent stream, since the local
 *  optimistic temp message doesn't grow over time. Matches the inline
 *  styling of ``MessageMarkdown``'s paragraph (17px / -0.2 letter /
 *  22px line) so the visual swap to full markdown on publish has no
 *  reflow. */
function StreamingTextBody({
  text,
  color,
  showCaret,
}: {
  text: string;
  color: string;
  showCaret: boolean;
}) {
  return (
    <Text style={[streamingStyles.text, { color }]}>
      {text}
      {showCaret ? <BlinkingCaret color={color} /> : null}
    </Text>
  );
}

function BlinkingCaret({ color }: { color: string }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(withTiming(0.2, { duration: 500 }), withTiming(1, { duration: 500 })),
      -1,
    );
    return () => {
      opacity.value = 1;
    };
  }, [opacity]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  // ``▍`` is a thin block character that reads as a caret without
  // needing an absolute-positioned animated view. Inline with the
  // text so it sits at the end of the last line as it grows.
  return (
    <Animated.Text style={[streamingStyles.caret, { color }, animatedStyle]}>
      {' ▍'}
    </Animated.Text>
  );
}

const streamingStyles = StyleSheet.create({
  caret: {
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: -0.2,
    lineHeight: 22,
  },
  text: {
    fontSize: 17,
    letterSpacing: -0.2,
    lineHeight: 22,
  },
});

const styles = StyleSheet.create({
  avatarCircle: {
    backgroundColor: '#00000022',
    borderRadius: AVATAR_SIZE / 2,
  },
  avatarSlot: {
    bottom: 0,
    height: AVATAR_SIZE,
    left: 12,
    position: 'absolute',
    width: AVATAR_SIZE,
  },
  adminBubble: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  adminCommandCopy: {
    flex: 1,
    minWidth: 0,
  },
  adminCommandDescription: {
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: -0.1,
    lineHeight: 16,
    marginTop: 2,
  },
  adminCommandGlyph: {
    alignItems: 'center',
    borderRadius: 11,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  adminCommandGlyphText: {
    color: IMESSAGE_BLUE,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 16,
  },
  adminCommandRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  adminCommandText: {
    color: IMESSAGE_BLUE,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.2,
    lineHeight: 20,
  },
  bubble: {
    // The bubble is now the single container for parent quote, image
    // grid, sender name, text, file cards, and reactions. Padding
    // happens on the inner padded column — the bubble itself stays at
    // padding:0 so the image grid can bleed to the rounded edges.
    maxWidth: '78%',
    overflow: 'hidden',
    padding: 0,
  },
  bubblePending: {
    opacity: 0.6,
  },
  bubbleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  failIcon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  flashOverlay: {
    borderRadius: 12,
    bottom: 1,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 1,
  },
  paddedInner: {
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  quote: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  quoteAccent: {
    alignSelf: 'stretch',
    borderRadius: 2,
    width: 3,
  },
  quoteAuthor: {
    fontSize: 12,
    fontWeight: '600',
  },
  quoteBody: {
    flex: 1,
  },
  quoteExcerpt: {
    fontSize: 12,
    marginTop: 1,
  },
  quotePressed: {
    opacity: 0.6,
  },
  quoteRemoved: {
    fontStyle: 'italic',
  },
  row: {
    // Full-width so ``alignItems`` actually has room to push the bubble
    // to one side; without this the row collapses to the bubble's
    // intrinsic width and ``maxWidth: '78%'`` on the bubble has nothing
    // definite to resolve against.
    alignSelf: 'stretch',
    paddingHorizontal: 12,
    position: 'relative',
  },
  rowFirst: {
    marginTop: 8,
  },
  rowLast: {
    marginBottom: 0,
  },
  rowOutgoing: {
    alignItems: 'flex-end',
  },
  rowTight: {
    marginTop: 2,
  },
  sender: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: -2,
  },
  status: {
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: -0.05,
    marginRight: 2,
    marginTop: 3,
    textAlign: 'right',
  },
});

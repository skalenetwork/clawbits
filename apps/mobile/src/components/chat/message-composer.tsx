import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  type StyleProp,
  Text,
  TextInput,
  type TextInputSelectionChangeEventData,
  View,
  type ViewStyle,
} from 'react-native';
// eslint-disable-next-line import/no-unresolved -- ships as source-only; resolved at bundle time via the `react-native` package.json field.
import { ContextMenuButton } from 'react-native-ios-context-menu';

import { AgentMenu } from '@/components/chat/agent-menu';
import { MentionPicker, mentionToken } from '@/components/chat/mention-picker';
import { RobotIcon } from '@/components/chat/robot-icon';
import { ScrollToBottomFab } from '@/components/chat/scroll-to-bottom-fab';
import { useTheme } from '@/hooks/use-theme';
import type { MmChannelMember } from '@/lib/api';

const IMESSAGE_BLUE = '#0A84FF';

interface MessageComposerProps {
  onSend: (message: string) => Promise<void>;
  onPickPhotos?: () => void;
  onPickFiles?: () => void;
  onLayout?: (event: LayoutChangeEvent) => void;
  /** Called at most once per 3s while the user is actively typing. */
  onTyping?: () => void;
  /** When set, the composer is editing an existing message. */
  editing?: {
    initialText: string;
    onCancel: () => void;
  };
  /** When set, the composer is replying to a message — render a quote banner. */
  replyingTo?: {
    authorName: string;
    excerpt: string;
    onCancel: () => void;
  };
  /** Channel members offered for @-mention completion. */
  mentionableMembers?: MmChannelMember[];
  /** True when the user has pending attachments — enables send even with empty text. */
  hasAttachments?: boolean;
  /** True when attachments are still uploading — visually disables send. */
  sendBlocked?: boolean;
  /** Show the inline scroll-to-bottom chip on the right side of the input. */
  showScrollToBottom?: boolean;
  /** Invoked when the user taps the scroll-to-bottom chip. */
  onScrollToBottom?: () => void;
}

interface MentionContext {
  /** Index of the ``@`` character that opened the current mention. */
  start: number;
  /** Text the user has typed after ``@`` — already lowercased for matching. */
  partial: string;
}

/** Scan ``text[0..cursor]`` for an active ``@partial`` token. A mention is
 *  active when the most recent ``@`` before the cursor is at the start of
 *  the message or preceded by whitespace, and nothing the user has typed
 *  since includes a space. Returns ``null`` when there's nothing to
 *  complete. */
function getMentionContext(text: string, cursor: number): MentionContext | null {
  if (cursor <= 0 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  const atIndex = before.lastIndexOf('@');
  if (atIndex < 0) return null;
  if (atIndex > 0) {
    const prev = text[atIndex - 1] ?? '';
    if (!/\s/.test(prev)) return null;
  }
  const partial = text.slice(atIndex + 1, cursor);
  if (/\s/.test(partial)) return null;
  return { start: atIndex, partial: partial.toLowerCase() };
}

const TYPING_PING_INTERVAL_MS = 3000;

export function MessageComposer({
  onSend,
  onPickPhotos,
  onPickFiles,
  onLayout,
  onTyping,
  editing,
  replyingTo,
  mentionableMembers,
  hasAttachments = false,
  sendBlocked = false,
  showScrollToBottom = false,
  onScrollToBottom,
}: MessageComposerProps) {
  const theme = useTheme();
  const [value, setValue] = useState(editing?.initialText ?? '');
  const [sending, setSending] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const lastTypingPingRef = useRef<number>(0);
  const inputRef = useRef<TextInput>(null);
  const trimmed = value.trim();
  const hasText = trimmed.length > 0;
  const canShowSend = hasText || hasAttachments;
  const sendDisabled = sending || sendBlocked || (!hasText && !hasAttachments);

  const mentionContext =
    selection.start === selection.end ? getMentionContext(value, selection.start) : null;
  const filteredMembers = useMemo(() => {
    if (!mentionContext || !mentionableMembers || mentionableMembers.length === 0) {
      return [];
    }
    const needle = mentionContext.partial;
    return mentionableMembers
      .filter((m) => {
        const handle = mentionToken(m).toLowerCase();
        const name = (m.display_name ?? '').toLowerCase();
        return handle.startsWith(needle) || name.includes(needle);
      })
      .slice(0, 12);
  }, [mentionContext, mentionableMembers]);
  const showMentionPicker = mentionContext != null && filteredMembers.length > 0;

  const agentMembers = useMemo<MmChannelMember[]>(() => {
    if (!Array.isArray(mentionableMembers)) return [];
    const out: MmChannelMember[] = [];
    for (const m of mentionableMembers) {
      if (m && m.agent_id != null) out.push(m);
    }
    return out;
  }, [mentionableMembers]);
  const showAgentPicker = agentPickerOpen && !showMentionPicker && agentMembers.length > 0;

  const handleChangeText = (next: string) => {
    setValue(next);
    if (!onTyping || next.length === 0) return;
    const now = Date.now();
    if (now - lastTypingPingRef.current > TYPING_PING_INTERVAL_MS) {
      lastTypingPingRef.current = now;
      onTyping();
    }
  };

  const handleSelectionChange = (
    event: NativeSyntheticEvent<TextInputSelectionChangeEventData>,
  ) => {
    setSelection(event.nativeEvent.selection);
  };

  const insertMention = (member: MmChannelMember) => {
    if (!mentionContext) return;
    const token = mentionToken(member);
    const before = value.slice(0, mentionContext.start);
    const after = value.slice(selection.end);
    const insertion = `@${token} `;
    const next = `${before}${insertion}${after}`;
    const nextCursor = mentionContext.start + insertion.length;
    setValue(next);
    setSelection({ start: nextCursor, end: nextCursor });
    // Re-focus + push the selection so the keyboard cursor matches state.
    inputRef.current?.setNativeProps?.({
      selection: { start: nextCursor, end: nextCursor },
    });
  };

  const insertAgentMention = (member: MmChannelMember) => {
    const token = mentionToken(member);
    const cursor = selection.end;
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    // Insert a leading space when the cursor sits flush against existing
    // non-whitespace text so mentions don't collide with prior words.
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
    const insertion = `${needsLeadingSpace ? ' ' : ''}@${token} `;
    const next = `${before}${insertion}${after}`;
    const nextCursor = before.length + insertion.length;
    setValue(next);
    setSelection({ start: nextCursor, end: nextCursor });
    setAgentPickerOpen(false);
    inputRef.current?.setNativeProps?.({
      selection: { start: nextCursor, end: nextCursor },
    });
    inputRef.current?.focus();
  };

  const submit = async () => {
    if (sendDisabled) return;
    if (process.env.EXPO_OS === 'ios') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    const message = trimmed;
    setValue('');
    setSending(true);
    try {
      await onSend(message);
    } catch {
      setValue(message);
    } finally {
      setSending(false);
    }
  };

  return (
    <View onLayout={onLayout}>
      {showMentionPicker ? (
        <MentionPicker members={filteredMembers} onPick={insertMention} />
      ) : showAgentPicker ? (
        <AgentMenu members={agentMembers} onPick={insertAgentMention} />
      ) : null}
      {editing ? (
        <View style={[styles.editBanner, { backgroundColor: theme.backgroundElement }]}>
          <SymbolView
            name={{ ios: 'pencil', android: 'edit' }}
            size={14}
            tintColor={theme.textSecondary}
            weight="medium"
            style={styles.editIcon}
          />
          <Text style={[styles.editLabel, { color: theme.textSecondary }]} numberOfLines={1}>
            Editing message
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel edit"
            onPress={editing.onCancel}
            hitSlop={8}
            style={({ pressed }) => [styles.editClose, pressed && styles.pressed]}>
            <SymbolView
              name={{ ios: 'xmark.circle.fill', android: 'cancel' }}
              size={18}
              tintColor={theme.textSecondary}
              weight="medium"
            />
          </Pressable>
        </View>
      ) : null}
      {replyingTo ? (
        <View style={[styles.replyBanner, { backgroundColor: theme.backgroundElement }]}>
          <View style={[styles.replyAccent, { backgroundColor: IMESSAGE_BLUE }]} />
          <View style={styles.replyBody}>
            <Text style={[styles.replyAuthor, { color: theme.text }]} numberOfLines={1}>
              Replying to {replyingTo.authorName}
            </Text>
            <Text
              style={[styles.replyExcerpt, { color: theme.textSecondary }]}
              numberOfLines={1}>
              {replyingTo.excerpt || 'Attachment'}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
            onPress={replyingTo.onCancel}
            hitSlop={8}
            style={({ pressed }) => [styles.editClose, pressed && styles.pressed]}>
            <SymbolView
              name={{ ios: 'xmark.circle.fill', android: 'cancel' }}
              size={18}
              tintColor={theme.textSecondary}
              weight="medium"
            />
          </Pressable>
        </View>
      ) : null}
    <View style={styles.row}>
      {Platform.OS === 'ios' ? (
        <ContextMenuButton
          isMenuPrimaryAction
          menuConfig={{
            menuTitle: '',
            menuItems: [
              {
                actionKey: 'photos',
                actionTitle: 'Photo Library',
                icon: {
                  type: 'IMAGE_SYSTEM',
                  imageValue: { systemName: 'photo.on.rectangle' },
                },
              },
              {
                actionKey: 'files',
                actionTitle: 'Files',
                icon: {
                  type: 'IMAGE_SYSTEM',
                  imageValue: { systemName: 'folder' },
                },
              },
            ],
          }}
          onPressMenuItem={({ nativeEvent }) => {
            if (nativeEvent.actionKey === 'photos') onPickPhotos?.();
            else if (nativeEvent.actionKey === 'files') onPickFiles?.();
          }}>
          <GlassSurface style={styles.plus}>
            <View
              accessibilityRole="button"
              accessibilityLabel="Add attachment"
              style={styles.plusInner}>
              <SymbolView
                name={{ ios: 'plus', android: 'add' }}
                size={22}
                tintColor={theme.textSecondary}
                weight="medium"
                style={styles.plusIcon}
              />
            </View>
          </GlassSurface>
        </ContextMenuButton>
      ) : (
        <GlassSurface style={styles.plus}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add attachment"
            onPress={() =>
              Alert.alert('Attach', undefined, [
                { text: 'Photos', onPress: onPickPhotos },
                { text: 'Files', onPress: onPickFiles },
                { text: 'Cancel', style: 'cancel' },
              ])
            }
            hitSlop={6}
            style={({ pressed }) => [styles.plusInner, pressed && styles.pressed]}>
            <SymbolView
              name={{ ios: 'plus', android: 'add' }}
              size={22}
              tintColor={theme.textSecondary}
              weight="medium"
              style={styles.plusIcon}
            />
          </Pressable>
        </GlassSurface>
      )}

      {agentMembers.length > 0 ? (
        <GlassSurface style={styles.plus}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Mention agent"
            onPress={() => setAgentPickerOpen((v) => !v)}
            hitSlop={6}
            style={({ pressed }) => [styles.plusInner, pressed && styles.pressed]}>
            <RobotIcon
              size={22}
              color={agentPickerOpen ? IMESSAGE_BLUE : theme.textSecondary}
            />
          </Pressable>
        </GlassSurface>
      ) : null}

      <GlassSurface style={styles.inputWrap}>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={handleChangeText}
          onSelectionChange={handleSelectionChange}
          placeholder="Message"
          placeholderTextColor={theme.textSecondary}
          multiline
          style={[styles.input, { color: theme.text }]}
          textAlignVertical="center"
        />
        {canShowSend ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            onPress={submit}
            disabled={sendDisabled}
            hitSlop={6}
            style={({ pressed }) => [
              styles.sendButton,
              {
                backgroundColor: IMESSAGE_BLUE,
                opacity: sendDisabled ? 0.4 : pressed ? 0.7 : 1,
              },
            ]}>
            {sending ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <SymbolView
                name={{ ios: 'arrow.up', android: 'arrow_upward' }}
                size={18}
                tintColor="#FFFFFF"
                weight="bold"
                style={styles.sendIcon}
              />
            )}
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Voice"
            hitSlop={6}
            style={({ pressed }) => [styles.mic, pressed && styles.pressed]}>
            <SymbolView
              name={{ ios: 'mic.fill', android: 'mic' }}
              size={22}
              tintColor={theme.textSecondary}
              weight="medium"
              style={styles.micIcon}
            />
          </Pressable>
        )}
      </GlassSurface>

      {showScrollToBottom && onScrollToBottom ? (
        <ScrollToBottomFab onPress={onScrollToBottom} />
      ) : null}
    </View>
    </View>
  );
}

interface GlassSurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

function GlassSurface({ children, style }: GlassSurfaceProps) {
  const theme = useTheme();

  if (process.env.EXPO_OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView glassEffectStyle="regular" style={[styles.glassBase, style]}>
        {children}
      </GlassView>
    );
  }

  if (process.env.EXPO_OS === 'ios') {
    return (
      <BlurView tint="systemChromeMaterial" intensity={70} style={[styles.glassBase, style]}>
        {children}
      </BlurView>
    );
  }

  return (
    <View style={[styles.glassBase, { backgroundColor: theme.backgroundElement }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  editBanner: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
    marginHorizontal: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  editClose: {
    alignItems: 'center',
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  editIcon: {
    height: 14,
    width: 14,
  },
  editLabel: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
  },
  replyBanner: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
    marginHorizontal: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  replyAccent: {
    alignSelf: 'stretch',
    borderRadius: 2,
    width: 3,
  },
  replyBody: {
    flex: 1,
  },
  replyAuthor: {
    fontSize: 13,
    fontWeight: '600',
  },
  replyExcerpt: {
    fontSize: 12,
    marginTop: 1,
  },
  glassBase: {
    overflow: 'hidden',
  },
  input: {
    // Opt out of the row's `alignItems: 'flex-end'` so a single line of text
    // sits visually centered in the pill (otherwise it hugs the bottom edge
    // because the input is shorter than the trailing button). For multi-line
    // input the TextInput fills the available height anyway, so this only
    // affects the short-draft case — the send/mic button still rides the
    // bottom thanks to the row default.
    alignSelf: 'center',
    flex: 1,
    fontSize: 17,
    letterSpacing: -0.2,
    lineHeight: 22,
    maxHeight: 120,
    minHeight: 22,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  inputWrap: {
    // `flex-end` keeps the send button anchored to the bottom edge of the
    // pill: visually centered for a one-line draft (input and button heights
    // are close), and pinned to the last line as the textarea grows so the
    // button doesn't drift up into the middle of the message.
    alignItems: 'flex-end',
    borderRadius: 22,
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    minHeight: 44,
    paddingLeft: 16,
    // Tight right padding so the send button hugs the pill edge — the
    // button itself has its own visual padding via the rounded background.
    paddingRight: 5,
    paddingVertical: 5,
  },
  mic: {
    alignItems: 'center',
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  micIcon: {
    height: 22,
    width: 22,
  },
  plus: {
    borderRadius: 22,
    height: 44,
    width: 44,
  },
  plusIcon: {
    height: 22,
    width: 22,
  },
  plusInner: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
  row: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 16,
  },
  sendButton: {
    alignItems: 'center',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  sendIcon: {
    height: 18,
    width: 18,
  },
});

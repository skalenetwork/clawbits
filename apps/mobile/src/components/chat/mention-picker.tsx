import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { memo, type ReactNode } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Avatar } from '@/components/avatar';
import { useTheme } from '@/hooks/use-theme';
import type { MmChannelMember } from '@/lib/api';

interface MentionPickerProps {
  /** Members matching the user's current ``@partial`` — already filtered
   *  and sorted by the composer. */
  members: MmChannelMember[];
  onPick: (member: MmChannelMember) => void;
}

const MAX_VISIBLE_ROWS = 4;
const ROW_HEIGHT = 44;

export const MentionPicker = memo(function MentionPicker({
  members,
  onPick,
}: MentionPickerProps) {
  const theme = useTheme();
  if (members.length === 0) return null;

  const maxHeight = ROW_HEIGHT * Math.min(members.length, MAX_VISIBLE_ROWS) + 8;

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <MentionSurface style={[styles.panel, { maxHeight }]}>
        <FlatList
          data={members}
          keyExtractor={(m) => mentionKey(m)}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Mention ${item.display_name ?? mentionToken(item)}`}
              onPress={() => onPick(item)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
              <Avatar
                uri={item.avatar?.url}
                name={item.display_name}
                size={28}
                framed={false}
              />
              <View style={styles.rowBody}>
                <Text
                  style={[styles.name, { color: theme.text }]}
                  numberOfLines={1}>
                  {item.display_name ?? mentionToken(item)}
                </Text>
                <Text
                  style={[styles.handle, { color: theme.textSecondary }]}
                  numberOfLines={1}>
                  @{mentionToken(item)}
                </Text>
              </View>
            </Pressable>
          )}
          keyboardShouldPersistTaps="always"
        />
      </MentionSurface>
    </View>
  );
});

function MentionSurface({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  if (process.env.EXPO_OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView glassEffectStyle="regular" style={[styles.surface, style]}>
        {children}
      </GlassView>
    );
  }
  if (process.env.EXPO_OS === 'ios') {
    return (
      <BlurView tint="systemChromeMaterial" intensity={80} style={[styles.surface, style]}>
        {children}
      </BlurView>
    );
  }
  return (
    <View style={[styles.surface, { backgroundColor: theme.backgroundElement }, style]}>
      {children}
    </View>
  );
}

/** Stable identifier for keying members in the picker list. Mirrors the
 *  backend's ``human:<id>`` / ``agent:<id>`` convention. */
function mentionKey(m: MmChannelMember): string {
  if (m.human_id != null) return `h:${m.human_id}`;
  if (m.agent_id != null) return `a:${m.agent_id}`;
  return `unknown:${m.joined_at}`;
}

/** Token inserted into the composer for a mention — the agent_id is its
 *  literal handle; humans don't have one yet so we fall back to a
 *  display-name-derived slug. */
export function mentionToken(m: MmChannelMember): string {
  if (m.agent_id) return m.agent_id;
  if (m.display_name) return m.display_name.replace(/\s+/g, '_').toLowerCase();
  if (m.human_id != null) return String(m.human_id);
  return 'unknown';
}

const styles = StyleSheet.create({
  handle: {
    fontSize: 12,
    marginTop: 1,
  },
  name: {
    fontSize: 15,
    fontWeight: '500',
  },
  panel: {
    overflow: 'hidden',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    height: ROW_HEIGHT,
    paddingHorizontal: 12,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowPressed: {
    opacity: 0.6,
  },
  surface: {
    borderRadius: 14,
  },
  wrap: {
    marginBottom: 6,
    marginHorizontal: 14,
  },
});

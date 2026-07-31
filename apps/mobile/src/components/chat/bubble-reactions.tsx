import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import type { MmReactionAggregate } from '@/lib/api';

interface BubbleReactionsProps {
  reactions: MmReactionAggregate[];
  viewerHumanId: number | null;
  isOutgoing: boolean;
  onPress?: (emoji: string) => void;
}

/**
 * Reaction pills rendered INSIDE the message bubble, at the bottom of
 * its padded inner column. No outer alignment wrapper — the bubble's
 * flex parent already centres / aligns the bubble itself, and the row
 * wraps left-to-right inside that bounded width.
 *
 * Pill backgrounds are tuned for the on-bubble context:
 *   - incoming bubble (theme gray): pills get the page bg so they punch
 *     out of the bubble surface;
 *   - outgoing bubble (iOS blue): pills get a translucent white overlay
 *     so they read as a lighter blue chip.
 *
 * "Mine" reactions invert to the bubble's text colour for the highest
 * contrast against the pill, keeping the existing visual language.
 */
export const BubbleReactions = memo(function BubbleReactions({
  reactions,
  viewerHumanId,
  isOutgoing,
  onPress,
}: BubbleReactionsProps) {
  if (reactions.length === 0) return null;

  return (
    <View style={styles.row}>
      {reactions.map((r) => (
        <Pill
          key={r.emoji}
          reaction={r}
          mine={viewerHumanId != null && r.human_ids.includes(viewerHumanId)}
          isOutgoing={isOutgoing}
          onPress={onPress ? () => onPress(r.emoji) : undefined}
        />
      ))}
    </View>
  );
});

function Pill({
  reaction,
  mine,
  isOutgoing,
  onPress,
}: {
  reaction: MmReactionAggregate;
  mine: boolean;
  isOutgoing: boolean;
  onPress?: () => void;
}) {
  const theme = useTheme();

  const bg = mine
    ? isOutgoing
      ? '#FFFFFF'
      : theme.text
    : isOutgoing
      ? 'rgba(255,255,255,0.22)'
      : theme.background;

  const fg = mine
    ? isOutgoing
      ? '#0A84FF'
      : theme.background
    : isOutgoing
      ? '#FFFFFF'
      : theme.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${reaction.emoji} reaction, ${reaction.count}`}
      onPress={onPress}
      disabled={!onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: bg, opacity: pressed ? 0.7 : 1 },
      ]}>
      <Text style={styles.emoji}>{reaction.emoji}</Text>
      <Text style={[styles.count, { color: fg }]}>{reaction.count}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  count: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  emoji: {
    fontSize: 15,
  },
  pill: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
});

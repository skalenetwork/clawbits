import { StyleSheet, View } from 'react-native';

import { GlassCard } from '@/components/home/glass-card';

import { Skeleton } from './skeleton';

const AVATAR_SIZE = 40;
const CARD_RADIUS = 20;
const CARD_COUNT = 4;

/** Loading placeholder for the "Jump back in" grid. Mirrors the real
 *  ``JumpCard`` shape (liquid-glass card, 40pt round avatar, two text
 *  lines) so the loading→loaded swap doesn't reflow. */
export function JumpBackInSkeleton() {
  const cards = Array.from({ length: CARD_COUNT });

  return (
    <View style={styles.grid}>
      {cards.map((_, i) => (
        <View key={i} style={styles.cardWrap}>
          <GlassCard radius={CARD_RADIUS} style={styles.card}>
            <Skeleton
              width={AVATAR_SIZE}
              height={AVATAR_SIZE}
              radius={AVATAR_SIZE / 2}
            />
            <Skeleton width="66%" height={15} radius={4} />
            <Skeleton width="50%" height={12} radius={4} />
          </GlassCard>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
  },
  cardWrap: {
    width: '48%',
  },
  card: {
    gap: 10,
    padding: 14,
  },
});

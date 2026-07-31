import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

import { Skeleton } from './skeleton';

const AVATAR_SIZE = 58;

/**
 * Single placeholder row shaped like a real `ChannelRow`: square-ish
 * avatar, title bar, preview bar, and a small timestamp block on the
 * right. The proportions intentionally mirror the live row so the
 * transition to real content is a colour-and-text swap rather than a
 * layout jump.
 */
export function ChannelRowSkeleton() {
  return (
    <View style={styles.row}>
      <Skeleton width={AVATAR_SIZE} height={AVATAR_SIZE} radius={15} />
      <View style={styles.content}>
        <Skeleton width="55%" height={14} radius={5} />
        <Skeleton width="80%" height={12} radius={5} />
      </View>
      <View style={styles.rightCol}>
        <Skeleton width={32} height={10} radius={4} />
      </View>
    </View>
  );
}

/** Stack of placeholder rows wrapped inside the same rounded card the
 *  real list uses so the empty → loaded transition keeps the rounded
 *  corners stable. */
export function ChannelListSkeleton({ rowCount = 6 }: { rowCount?: number }) {
  const theme = useTheme();
  const rows = Array.from({ length: rowCount });

  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
      {rows.map((_, i) => (
        <View key={i}>
          <ChannelRowSkeleton />
          {i < rows.length - 1 ? (
            <View
              style={[styles.divider, { backgroundColor: theme.backgroundSelected }]}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    marginHorizontal: 20,
    marginTop: 50,
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    gap: 8,
    minWidth: 0,
    paddingRight: 72,
    paddingTop: 6,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 70,
  },
  rightCol: {
    position: 'absolute',
    right: 16,
    top: 16,
  },
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});

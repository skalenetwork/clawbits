import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Skeleton } from './skeleton';

interface MessageListSkeletonProps {
  topPadding?: number;
  bottomPadding?: number;
  style?: StyleProp<ViewStyle>;
}

/** Bubble shapes are deliberate: each row alternates `mine`/`theirs` to
 *  echo the staggered look of a real conversation. Widths/heights are
 *  fixed (not random) so re-renders during the loading window don't
 *  reshuffle the placeholder layout. */
const ROWS: { mine: boolean; width: number | `${number}%`; height: number }[] = [
  { mine: false, width: '64%', height: 38 },
  { mine: true, width: '52%', height: 28 },
  { mine: false, width: '78%', height: 52 },
  { mine: true, width: '38%', height: 28 },
  { mine: false, width: '46%', height: 28 },
  { mine: true, width: '70%', height: 44 },
  { mine: false, width: '58%', height: 28 },
];

export function MessageListSkeleton({
  topPadding = 0,
  bottomPadding = 0,
  style,
}: MessageListSkeletonProps) {
  return (
    <View
      style={[
        styles.container,
        { paddingTop: topPadding, paddingBottom: bottomPadding },
        style,
      ]}>
      {ROWS.map((row, i) => (
        <View
          key={i}
          style={[styles.row, row.mine ? styles.alignRight : styles.alignLeft]}>
          <Skeleton width={row.width} height={row.height} radius={18} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  alignLeft: {
    alignItems: 'flex-start',
  },
  alignRight: {
    alignItems: 'flex-end',
  },
  container: {
    flex: 1,
    gap: 10,
    paddingHorizontal: 14,
  },
  row: {
    flexDirection: 'row',
  },
});

import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import { formatSeparator } from '@/lib/chat-grouping';

interface DateSeparatorProps {
  isoTime: string;
}

export const DateSeparator = memo(function DateSeparator({ isoTime }: DateSeparatorProps) {
  const theme = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: theme.textSecondary }]}>
        {formatSeparator(isoTime)}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  label: {
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    fontWeight: '500',
    letterSpacing: -0.1,
  },
  wrap: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
});

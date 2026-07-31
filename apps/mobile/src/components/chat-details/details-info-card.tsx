import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { useTheme } from '@/hooks/use-theme';

export interface InfoRow {
  key: string;
  symbol: { ios: SFSymbol; android: AndroidSymbol };
  label: string;
  value: string;
}

interface DetailsInfoCardProps {
  rows: readonly InfoRow[];
}

/**
 * Settings-style card with stacked rows for "About" facts — channel
 * created date, member count, peer email on DMs, etc. Visually
 * consistent with the settings/index card layout (radius 22,
 * ``backgroundElement`` surface, hairline dividers between rows).
 *
 * Read-only. Rows are not pressable here — taps on info don't need to
 * lead anywhere on this screen. If a row ever needs to navigate (e.g.
 * "14 members →"), promote it out of this card into a separate
 * pressable row component rather than overloading this one with
 * conditional onPress + chevron props.
 */
export function DetailsInfoCard({ rows }: DetailsInfoCardProps) {
  const theme = useTheme();

  if (rows.length === 0) return null;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.backgroundElement },
      ]}>
      {rows.map((row, idx) => {
        const isLast = idx === rows.length - 1;
        return (
          <View key={row.key}>
            <View style={styles.row}>
              <SymbolView
                name={row.symbol}
                size={20}
                tintColor={theme.textSecondary}
                weight="medium"
                style={styles.icon}
              />
              <Text
                style={[styles.label, { color: theme.textSecondary }]}
                numberOfLines={1}>
                {row.label}
              </Text>
              <Text
                style={[styles.value, { color: theme.text }]}
                numberOfLines={1}>
                {row.value}
              </Text>
            </View>
            {isLast ? null : (
              <View
                style={[
                  styles.divider,
                  { backgroundColor: theme.backgroundSelected },
                ]}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 22,
    overflow: 'hidden',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 52,
  },
  icon: {
    height: 20,
    width: 20,
  },
  label: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    letterSpacing: -0.1,
    marginLeft: 14,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 52,
    paddingHorizontal: 16,
  },
  value: {
    fontSize: 15,
    fontWeight: '500',
    letterSpacing: -0.1,
    marginLeft: 12,
    maxWidth: '55%',
    textAlign: 'right',
  },
});

import { Stack } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { MaxWidthContent } from '@/components/max-width-content';
import { useTheme } from '@/hooks/use-theme';
import {
  useThemeOverride,
  type ThemePreference,
} from '@/providers/theme-override-provider';

const SECTION_RADIUS = 22;

const OPTIONS: readonly {
  value: ThemePreference;
  label: string;
  subtitle: string;
  symbol: { ios: SFSymbol; android: AndroidSymbol };
}[] = [
  {
    value: 'system',
    label: 'System',
    subtitle: 'Match your device setting',
    symbol: { ios: 'iphone', android: 'smartphone' },
  },
  {
    value: 'light',
    label: 'Light',
    subtitle: 'Always light mode',
    symbol: { ios: 'sun.max.fill', android: 'wb_sunny' },
  },
  {
    value: 'dark',
    label: 'Dark',
    subtitle: 'Always dark mode',
    symbol: { ios: 'moon.fill', android: 'dark_mode' },
  },
];

export default function AppearanceScreen() {
  const theme = useTheme();
  const { preference, setPreference } = useThemeOverride();
  const headerHeight = useHeaderHeight();
  const androidHeaderPad = Platform.OS === 'android' ? headerHeight : 0;

  return (
    <>
      <Stack.Screen options={{ title: 'Appearance', headerBackTitle: 'Settings' }} />
      <View style={[styles.screen, { backgroundColor: theme.background }]}>
        <MaxWidthContent maxWidth={720}>
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: androidHeaderPad + 12 },
          ]}
          contentInsetAdjustmentBehavior="automatic">
          <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>
            Theme
          </Text>
          <View style={[styles.section, { backgroundColor: theme.backgroundElement }]}>
            {OPTIONS.map((option, idx) => {
              const isSelected = preference === option.value;
              const isLast = idx === OPTIONS.length - 1;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => void setPreference(option.value)}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                  <View style={styles.rowLeading}>
                    <SymbolView
                      name={option.symbol}
                      size={22}
                      tintColor={theme.text}
                      weight="regular"
                    />
                  </View>
                  <View
                    style={[
                      styles.rowBody,
                      !isLast && {
                        borderBottomColor: theme.backgroundSelected,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                      },
                    ]}>
                    <View style={styles.rowText}>
                      <Text
                        style={[styles.rowTitle, { color: theme.text }]}
                        numberOfLines={1}>
                        {option.label}
                      </Text>
                      <Text
                        style={[styles.rowSubtitle, { color: theme.textSecondary }]}
                        numberOfLines={1}>
                        {option.subtitle}
                      </Text>
                    </View>
                    {isSelected ? (
                      <SymbolView
                        name={{ ios: 'checkmark', android: 'check' }}
                        size={18}
                        tintColor="#0A84FF"
                        weight="semibold"
                      />
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.footer, { color: theme.textSecondary }]}>
            “System” follows your iOS Dark Mode setting and switches automatically.
          </Text>
        </ScrollView>
        </MaxWidthContent>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  footer: {
    fontSize: 13,
    lineHeight: 18,
    marginHorizontal: 8,
    marginTop: -8,
  },
  row: {
    flexDirection: 'row',
    paddingLeft: 16,
  },
  rowBody: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    minHeight: 56,
    paddingRight: 14,
    paddingVertical: 10,
  },
  rowLeading: {
    alignItems: 'center',
    height: 56,
    justifyContent: 'center',
    marginRight: 12,
    width: 30,
  },
  rowPressed: {
    opacity: 0.6,
  },
  rowSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 17,
    fontWeight: '400',
    letterSpacing: -0.2,
  },
  screen: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 96,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  section: {
    borderRadius: SECTION_RADIUS,
    marginBottom: 16,
    overflow: 'hidden',
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: -0.1,
    marginBottom: 8,
    marginLeft: 4,
  },
});

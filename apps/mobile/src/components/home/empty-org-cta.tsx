import { router } from 'expo-router';
import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { PressableScale } from '@/components/pressable-scale';
import { useTheme } from '@/hooks/use-theme';

type SymbolPair = { ios: SFSymbol; android: AndroidSymbol };

const AGENT_SYMBOL: SymbolPair = { ios: 'sparkles', android: 'auto_awesome' };
const INVITE_SYMBOL: SymbolPair = {
  ios: 'person.badge.plus',
  android: 'person_add',
};

/** First-run CTAs for an empty workspace (no other humans, no agents),
 *  mirroring the web home. "Add your first agent" is the primary action;
 *  "Invite people" routes to workspace settings (mobile has no dedicated
 *  members screen yet). */
export function EmptyOrgCta() {
  const theme = useTheme();

  return (
    <View style={styles.row}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Add your first agent"
        onPress={() => router.push('/add-agent')}
        pressedScale={0.97}
        style={[styles.button, { backgroundColor: theme.text }]}>
        <SymbolView
          name={AGENT_SYMBOL}
          size={16}
          tintColor={theme.background}
          weight="semibold"
        />
        <Text style={[styles.label, { color: theme.background }]}>
          Add your first agent
        </Text>
      </PressableScale>

      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Invite people"
        onPress={() => router.navigate('/settings/workspaces')}
        pressedScale={0.97}
        style={[
          styles.button,
          styles.outline,
          { borderColor: theme.backgroundSelected },
        ]}>
        <SymbolView name={INVITE_SYMBOL} size={16} tintColor={theme.text} />
        <Text style={[styles.label, { color: theme.text }]}>Invite people</Text>
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'center',
  },
  button: {
    alignItems: 'center',
    borderRadius: 10,
    flexDirection: 'row',
    gap: 6,
    height: 38,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  outline: {
    backgroundColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
});

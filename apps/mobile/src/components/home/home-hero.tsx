import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { Fonts } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatLongDate, getTimeOfDayGreeting } from '@/lib/formatting';

type SymbolPair = { ios: SFSymbol; android: AndroidSymbol };

const CALENDAR: SymbolPair = { ios: 'calendar', android: 'calendar_today' };
const UNREAD: SymbolPair = { ios: 'envelope.badge', android: 'mark_email_unread' };
const CONVOS: SymbolPair = {
  ios: 'bubble.left.and.bubble.right',
  android: 'forum',
};
const CAUGHT_UP: SymbolPair = { ios: 'checkmark.circle', android: 'check_circle' };

const ICON_SIZE = 13;

interface HomeHeroProps {
  /** Already-resolved first name (see ``pickFirstName``). */
  firstName: string;
  /** Snapshotted once per mount by the screen so the greeting + date stay
   *  stable across re-renders. */
  now: Date;
  unreadTotal: number;
  unreadConvos: number;
  /** First-run workspace (no other humans + no agents) — swaps the
   *  date/unread subline for a setup nudge, matching the web home. */
  isEmptyOrg: boolean;
}

/** The one editorial moment of the home screen: a large serif time-of-day
 *  greeting over a single quiet muted subline with inline status icons.
 *  Mirrors the web home hero (`frontend/src/pages/AgentHomePage.tsx`),
 *  centered for the calm launchpad layout. */
export function HomeHero({
  firstName,
  now,
  unreadTotal,
  unreadConvos,
  isEmptyOrg,
}: HomeHeroProps) {
  const theme = useTheme();
  const muted = theme.textSecondary;

  return (
    <View style={styles.wrap}>
      <Text style={[styles.greeting, { color: theme.text }]}>
        {getTimeOfDayGreeting(now)}, {firstName}
      </Text>

      {isEmptyOrg ? (
        <Text style={[styles.text, { color: muted }]}>
          Let&apos;s get your workspace set up
        </Text>
      ) : (
        <View style={styles.sublineCol}>
          {/* Line 1 — the date. */}
          <View style={styles.sublineRow}>
            <SymbolView name={CALENDAR} size={ICON_SIZE} tintColor={muted} />
            <Text style={[styles.text, { color: muted }]}>
              {formatLongDate(now)}
            </Text>
          </View>
          {/* Line 2 — unread status. */}
          <View style={styles.sublineRow}>
            {unreadTotal > 0 ? (
              <>
                <SymbolView name={UNREAD} size={ICON_SIZE} tintColor={muted} />
                <Text style={[styles.text, { color: muted }]}>
                  {unreadTotal} unread in
                </Text>
                <SymbolView name={CONVOS} size={ICON_SIZE} tintColor={muted} />
                <Text style={[styles.text, { color: muted }]}>
                  {unreadConvos} conversation{unreadConvos === 1 ? '' : 's'}
                </Text>
              </>
            ) : (
              <>
                <SymbolView name={CAUGHT_UP} size={ICON_SIZE} tintColor={muted} />
                <Text style={[styles.text, { color: muted }]}>
                  You&apos;re all caught up
                </Text>
              </>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'flex-start',
    gap: 10,
  },
  greeting: {
    fontFamily: Fonts.serif,
    fontSize: 34,
    fontWeight: '500',
    // RN letterSpacing is absolute px (no `em`); the web hero uses
    // tracking-tight (~-0.05em). -1 reads cleanest on a 34pt New York head.
    letterSpacing: -1,
    lineHeight: 40,
    textAlign: 'left',
  },
  sublineCol: {
    alignItems: 'flex-start',
    gap: 4,
  },
  sublineRow: {
    alignItems: 'center',
    columnGap: 5,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    rowGap: 2,
  },
  text: {
    fontSize: 14,
    letterSpacing: -0.2,
  },
});

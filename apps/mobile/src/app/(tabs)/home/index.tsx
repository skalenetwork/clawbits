import { Stack } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// eslint-disable-next-line import/no-unresolved -- Metro resolves platform files.
import { OrgSwitcher } from '@/components/org-switcher';
import { RealtimeStatusDot } from '@/components/realtime-status-dot';
import { SignInEmptyState } from '@/components/sign-in-empty-state';
import { CommandBar } from '@/components/home/command-bar';
import { EmptyOrgCta } from '@/components/home/empty-org-cta';
import { HomeHero } from '@/components/home/home-hero';
import { JumpBackIn } from '@/components/home/jump-back-in';
import { JumpBackInSkeleton } from '@/components/skeletons/jump-back-in-skeleton';
import { useChannels } from '@/hooks/use-channels';
import { useOrgAgents } from '@/hooks/use-org-agents';
import { useOrgMembers } from '@/hooks/use-org-members';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import { useTheme } from '@/hooks/use-theme';
import { SEARCH_BAR_REST, SEARCH_PILL_HEIGHT } from '@/components/search/search-dock';
import { pickFirstName } from '@/lib/formatting';
import { useAuth } from '@/providers/auth-provider';

/** Header title slot — the greeting lives in the in-content serif hero, so the
 *  nav bar carries no "Home" label; just the live realtime status dot. */
function HomeTitle() {
  return (
    <View style={styles.titleSlot}>
      <RealtimeStatusDot />
    </View>
  );
}

export default function HomeScreen() {
  const theme = useTheme();
  const { status, user } = useAuth();
  const { selectedOrg } = useSelectedOrg();
  const orgId = selectedOrg?.org_id ?? null;
  // The home screen doesn't scroll — it's a fixed launchpad centered between
  // the transparent header and the floating tab bar. The header is transparent
  // on both platforms and reserves no layout space, so we pad the top by its
  // height and the bottom by the tab-bar zone + home-indicator inset, then
  // ``flex:1 + justifyContent:'center'`` centers the column in what's left.
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();

  // Share the cache with the chats tab so flipping between tabs is
  // instant. Live updates arrive via the RealtimeProvider; on
  // foreground the focus-manager wiring refreshes the list, so the
  // home screen never needs a manual refresh control.
  const channelsQuery = useChannels(orgId, status === 'authenticated');

  // Agents + members are fetched only to detect a first-run (empty)
  // workspace, mirroring the web home. Gating the CTAs on settled queries
  // stops them flashing before the data loads.
  const agentsQuery = useOrgAgents(orgId, status === 'authenticated');
  const membersQuery = useOrgMembers(orgId, status === 'authenticated');

  // Snapshot `now` once per mount so the greeting + long date stay stable
  // across re-renders (and a tab-bar tap never reshuffles the wording).
  const [now] = useState(() => new Date());
  const channels = useMemo(
    () => channelsQuery.data?.channels ?? [],
    [channelsQuery.data?.channels],
  );
  const { unreadTotal, unreadConvos } = useMemo(() => {
    let total = 0;
    let convos = 0;
    for (const c of channels) {
      const n = c.unread_count ?? 0;
      if (n > 0) {
        total += n;
        convos += 1;
      }
    }
    return { unreadTotal: total, unreadConvos: convos };
  }, [channels]);
  const firstName = user ? pickFirstName(user) : 'there';

  const otherMembersCount = (membersQuery.data?.members ?? []).filter(
    (m) => m.human_id !== user?.id,
  ).length;
  const hasAnyAgent = (agentsQuery.data?.agents ?? []).length > 0;
  const settled = !agentsQuery.isLoading && !membersQuery.isLoading;
  const isEmptyOrg = settled && otherMembersCount === 0 && !hasAnyAgent;

  if (status === 'anonymous') {
    return (
      <>
        <Stack.Screen
          options={{
            headerTitle: () => <HomeTitle />,
            // Stack.Screen options merge across renders, so the
            // authenticated branch's org switcher would otherwise stick
            // around after sign-out. Render an empty slot to clear it.
            headerRight: () => null,
          }}
        />
        <View
          key={`screen-${status}`}
          style={[styles.screen, { backgroundColor: theme.background }]}>
          <SignInEmptyState
            symbol={{ ios: 'circle.grid.2x2.fill', android: 'apps' }}
            title="Welcome to Clawbits"
            subtitle="Your AI agents, workspaces, and conversations — all in one place."
          />
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => <HomeTitle />,
          headerRight: () => <OrgSwitcher />,
        }}
      />
      {/* React reuses the same UIView host for this outer View across
          the anonymous→authenticated transition because the JSX trees
          live at the same position. UIKit then keeps the inset values
          it computed during the sign-in formSheet's dismissal — leaving
          the content sliding up behind the transparent header until the
          next cold start. ``key={status}`` forces a remount on the auth
          flip so UIKit gets a clean layout pass. */}
      <View
        key={`screen-${status}`}
        style={[styles.screen, { backgroundColor: theme.background }]}>
        <View
          style={[
            styles.centered,
            {
              paddingTop: headerHeight,
              // Reserve the docked search bar's zone (tab-bar rest + pill +
              // breathing room) so the centered launchpad never sits under it.
              paddingBottom:
                insets.bottom + SEARCH_BAR_REST + SEARCH_PILL_HEIGHT + 24,
            },
          ]}>
          <View style={styles.launchpad}>
            <HomeHero
              firstName={firstName}
              now={now}
              unreadTotal={unreadTotal}
              unreadConvos={unreadConvos}
              isEmptyOrg={isEmptyOrg}
            />

            {!isEmptyOrg &&
              (channelsQuery.isLoading ? (
                <JumpBackInSkeleton />
              ) : (
                <JumpBackIn channels={channels} />
              ))}

            {isEmptyOrg && <EmptyOrgCta />}
          </View>
        </View>

        {/* Docked search bar — same component + position as the Search tab. */}
        <CommandBar />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // Fills the area between header and tab bar (padding applied inline) and
  // centers the launchpad in it — no scrolling.
  centered: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  // The calm launchpad column: hero + command bar + recents, with a uniform
  // 32pt rhythm. Capped width so it stays tidy in landscape / on large phones.
  launchpad: {
    gap: 32,
    maxWidth: 560,
    width: '100%',
  },
  screen: {
    flex: 1,
  },
  titleSlot: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    width: '100%',
  },
});

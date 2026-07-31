import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { MaxWidthContent } from '@/components/max-width-content';
import { SheetGrabber } from '@/components/sheet-grabber';
import { DetailsActionRow, type DetailsAction } from '@/components/chat-details/details-action-row';
import { DetailsHero } from '@/components/chat-details/details-hero';
import { DetailsInfoCard, type InfoRow } from '@/components/chat-details/details-info-card';
import { DetailsTabs, type DetailsTabsTab } from '@/components/chat-details/details-tabs';
import { FilesTab } from '@/components/chat-details/files-tab';
import { LinksTab } from '@/components/chat-details/links-tab';
import { MediaTab } from '@/components/chat-details/media-tab';
import { MembersTab } from '@/components/chat-details/members-tab';
import { useChannelMembers } from '@/hooks/use-channel-members';
import { useChannels } from '@/hooks/use-channels';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import { useTheme } from '@/hooks/use-theme';
import { useTabBarVisibility } from '@/providers/tab-bar-visibility';
import {
  leaveMmChannel,
  setMmChannelMuted,
  type MmChannel,
} from '@/lib/api';
import { formatChannelTitle } from '@/lib/formatting';
import { useAuth } from '@/providers/auth-provider';

type TabValue = 'media' | 'files' | 'links' | 'members';

// Snappy-but-not-bouncy spring shared between the layout effect (tab-bar
// taps, rotation) and the gesture's onEnd (swipe rebound when the user
// doesn't cross the commit threshold).
const PAGE_SPRING = { damping: 22, stiffness: 220, mass: 0.7 } as const;

interface ChannelsCache {
  channels: MmChannel[];
  total: number;
}

/**
 * Channel / DM details sheet.
 *
 * Opens when the user taps the name pill in the chat header. Adaptive
 * presentation: bottom form sheet on phones (swipe to dismiss), full
 * modal on tablets / foldable inner displays. Internal layout is one
 * scrollable column — hero card → action row → info card → animated
 * segmented tabs → tab content. Each tab subscribes its own paginated
 * data query and stays subscribed across tab switches so re-entry is
 * instant.
 *
 * Channel record comes from the cached ``useChannels`` list — every
 * chat row the user has seen is already there. If the cache is cold
 * (the sheet was opened from a deep link or a fresh launch) the screen
 * renders an empty hero until the list resolves, then re-renders.
 */
export default function ChatDetailsScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const theme = useTheme();
  const { selectedOrg } = useSelectedOrg();
  const orgId = selectedOrg?.org_id ?? null;
  const channelsQuery = useChannels(orgId);
  const channel = useMemo(
    () => channelsQuery.data?.channels.find((c) => c.channel_id === channelId) ?? null,
    [channelsQuery.data, channelId],
  );
  const members = useChannelMembers(channelId ?? '');

  const isDirect = channel?.channel_type === 'direct';
  const [activeTab, setActiveTab] = useState<TabValue>('media');

  // Hold the tab-bar-hidden request for the entire lifetime of this sheet
  // (mount → unmount, not focus → blur) so the bar doesn't briefly flash
  // back in during the push/pop animation handoff with the chat screen
  // underneath. ``requestHidden()`` is counter-based — the chat screen's
  // own hold and ours overlap during the transition, count never reaches
  // zero, bar stays hidden.
  const { requestHidden } = useTabBarVisibility();
  useEffect(() => {
    const release = requestHidden();
    return release;
  }, [requestHidden]);
  // Width of one pager page, set on layout. Pages are laid out side-by-side
  // inside an `Animated.View` whose translateX is driven both by user
  // swipes and by tab-bar taps (via the effect below).
  const [pageWidth, setPageWidth] = useState(0);
  const pageTranslateX = useSharedValue(0);
  const onPagerLayout = useCallback((e: LayoutChangeEvent) => {
    setPageWidth(e.nativeEvent.layout.width);
  }, []);

  // Members tab is hidden on DMs — a 1:1 list of "the other person"
  // wouldn't add anything the hero doesn't already show.
  const tabs: readonly DetailsTabsTab<TabValue>[] = isDirect
    ? [
        { value: 'media', label: 'Media' },
        { value: 'files', label: 'Files' },
        { value: 'links', label: 'Links' },
      ]
    : [
        { value: 'media', label: 'Media' },
        { value: 'files', label: 'Files' },
        { value: 'links', label: 'Links' },
        { value: 'members', label: 'Members', count: members.length || undefined },
      ];

  const infoRows = useMemo(
    () => buildInfoRows(channel, members.length),
    [channel, members.length],
  );

  const actions = useChannelActions(channel, isDirect ?? false);

  const tabIndex = tabs.findIndex((t) => t.value === activeTab);
  const safeIndex = tabIndex < 0 ? 0 : tabIndex;

  // Horizontal swipe gesture — uses `react-native-gesture-handler` instead
  // of `PanResponder` so it composes cleanly with the outer vertical
  // ScrollView's native scroll. `activeOffsetX` only claims the touch
  // after a clear horizontal drag of 12pt; `failOffsetY` aborts the
  // gesture as soon as the finger moves >12pt vertically, handing the
  // touch back to the ScrollView for normal scrolling. The gesture is
  // recreated each render so it always closes over the latest
  // `safeIndex` / `pageWidth` / `tabs.length`.
  const tabsLen = tabs.length;
  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      'worklet';
      if (pageWidth === 0) return;
      const baseX = -safeIndex * pageWidth;
      const nextX = Math.max(
        -(tabsLen - 1) * pageWidth,
        Math.min(0, baseX + e.translationX),
      );
      pageTranslateX.value = nextX;
    })
    .onEnd((e) => {
      'worklet';
      if (pageWidth === 0) return;
      const shouldMoveLeft = e.translationX < -pageWidth * 0.22 || e.velocityX < -550;
      const shouldMoveRight = e.translationX > pageWidth * 0.22 || e.velocityX > 550;
      let next = safeIndex;
      if (shouldMoveLeft) next = safeIndex + 1;
      else if (shouldMoveRight) next = safeIndex - 1;
      const clamped = Math.max(0, Math.min(tabsLen - 1, next));
      if (clamped !== safeIndex) {
        // Hop to JS to update React state; the spring follows via the
        // `[safeIndex, pageWidth]` effect above.
        runOnJS(setActiveTab)(tabs[clamped].value);
      } else {
        // No tab change — spring back to the current page.
        pageTranslateX.value = withSpring(-safeIndex * pageWidth, PAGE_SPRING);
      }
    });

  const pagerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pageTranslateX.value }],
  }));

  // Spring the page row to whichever tab is active. Fires on tab-bar taps,
  // on swipe-release (after `setActiveTab`), and on first layout / rotation
  // so the row stays anchored to the right page when the viewport width
  // changes. Skips while `pageWidth === 0` (pre-measure).
  useAnimatedReaction(
    () => ({ pageWidth, safeIndex }),
    ({ pageWidth: width, safeIndex: index }) => {
      if (width === 0) return;
      // eslint-disable-next-line react-hooks/immutability -- Reanimated SharedValue write in UI worklet.
      pageTranslateX.value = withSpring(-index * width, PAGE_SPRING);
    },
    [safeIndex, pageWidth],
  );

  const subtitleSuffix = !isDirect && members.length > 0
    ? `${members.length} ${members.length === 1 ? 'member' : 'members'}`
    : undefined;

  return (
    <>
      <Stack.Screen
        options={{
          // No nav header inside the sheet — the hero card is the
          // visual title and the user dismisses via swipe-down (phone)
          // or background tap (tablet). Matches the new-channel,
          // browse-channels sheets in the rest of the app.
          contentStyle: { backgroundColor: theme.background },
        }}
      />
      <SheetGrabber />
      <MaxWidthContent maxWidth={640} insetTopWhenLarge>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}>
          {channel ? (
            <DetailsHero channel={channel} subtitleSuffix={subtitleSuffix} />
          ) : (
            // Skeleton hero — kept the same height as the real one so
            // the layout doesn't pop when the channel resolves.
            <View
              style={[
                styles.heroSkeleton,
                { backgroundColor: theme.backgroundElement },
              ]}
            />
          )}

          <View style={styles.actionRowWrap}>
            <DetailsActionRow actions={actions} />
          </View>

          {infoRows.length > 0 ? (
            <View style={styles.infoCardWrap}>
              <DetailsInfoCard rows={infoRows} />
            </View>
          ) : null}

          <View style={styles.tabsWrap}>
            <DetailsTabs<TabValue>
              tabs={tabs}
              value={activeTab}
              onChange={setActiveTab}
            />
          </View>

          <View style={styles.tabContent} onLayout={onPagerLayout}>
            {channelId ? (
              // All tab pages laid out side-by-side inside a translating
              // row. Each tab stays mounted across switches so re-entry is
              // instant; ``active`` still gates the underlying query so
              // unopened tabs don't trigger HTTP fetches.
              <GestureDetector gesture={swipeGesture}>
                <View style={styles.pagerViewport}>
                  <Animated.View
                    style={[
                      styles.pagerRow,
                      { width: pageWidth * tabs.length },
                      pagerStyle,
                    ]}>
                    {tabs.map((tab) => (
                      <View key={tab.value} style={{ width: pageWidth }}>
                        {renderTab(tab.value, channelId, activeTab)}
                      </View>
                    ))}
                  </Animated.View>
                </View>
              </GestureDetector>
            ) : null}
          </View>
        </ScrollView>
      </MaxWidthContent>
    </>
  );
}

function renderTab(value: TabValue, channelId: string, activeTab: TabValue) {
  switch (value) {
    case 'media':
      return <MediaTab channelId={channelId} active={activeTab === 'media'} />;
    case 'files':
      return <FilesTab channelId={channelId} active={activeTab === 'files'} />;
    case 'links':
      return <LinksTab channelId={channelId} active={activeTab === 'links'} />;
    case 'members':
      return <MembersTab channelId={channelId} />;
  }
}

function buildInfoRows(channel: MmChannel | null, memberCount: number): InfoRow[] {
  if (!channel) return [];
  const rows: InfoRow[] = [];
  rows.push({
    key: 'type',
    symbol: { ios: 'tag', android: 'label' },
    label: 'Type',
    value:
      channel.channel_type === 'public'
        ? 'Public'
        : channel.channel_type === 'private'
          ? 'Private'
          : 'Direct',
  });
  if (channel.created_at) {
    rows.push({
      key: 'created',
      symbol: { ios: 'calendar', android: 'event' },
      label: 'Created',
      value: formatDate(channel.created_at),
    });
  }
  if (channel.channel_type !== 'direct' && memberCount > 0) {
    rows.push({
      key: 'members',
      symbol: { ios: 'person.2', android: 'group' },
      label: 'Members',
      value: String(memberCount),
    });
  }
  if (channel.muted) {
    rows.push({
      key: 'muted',
      symbol: { ios: 'bell.slash', android: 'notifications_off' },
      label: 'Notifications',
      value: 'Muted',
    });
  }
  return rows;
}

/** Action row factory hook — owns the mutations behind the three live
 *  actions (Mute / Add / Leave) and renders the not-yet-wired ones
 *  (Search / Pin / Block) as visual placeholders.
 *
 *  The mute mutation does an optimistic cache patch so the icon flips
 *  instantly; the server's ``channel.muted`` SSE event re-confirms (or
 *  corrects, on rollback) once it arrives. Leave goes through a
 *  destructive confirm dialog because the action is non-reversible
 *  from this surface (the user would have to be re-invited).
 *
 *  Returns an empty array while the channel record is still loading —
 *  the action row briefly renders fewer tiles, which reads as a
 *  natural skeleton rather than a layout pop. */
function useChannelActions(
  channel: MmChannel | null,
  isDirect: boolean,
): DetailsAction[] {
  const { token, user } = useAuth();
  const { selectedOrg } = useSelectedOrg();
  const orgId = selectedOrg?.org_id ?? null;
  const queryClient = useQueryClient();
  const channelId = channel?.channel_id ?? null;
  const isMuted = !!channel?.muted;

  const muteMutation = useMutation({
    mutationFn: ({ nextMuted }: { nextMuted: boolean }) => {
      if (!channelId) throw new Error('no channel');
      return setMmChannelMuted(token, channelId, nextMuted);
    },
    // Patch the channels cache before the round trip so the icon /
    // label flip happens on the same animation frame as the tap —
    // SSE later confirms. Save the previous list so ``onError`` can
    // roll back if the server rejects the toggle.
    onMutate: async ({ nextMuted }) => {
      if (!channelId) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey: ['channels', orgId] });
      const previous = queryClient.getQueryData<ChannelsCache>(['channels', orgId]);
      queryClient.setQueryData<ChannelsCache>(['channels', orgId], (prev) =>
        patchChannelMuted(prev, channelId, nextMuted),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(['channels', orgId], ctx.previous);
      }
    },
    onSuccess: () => {
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.selectionAsync();
      }
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => {
      if (!channelId) throw new Error('no channel');
      if (!user?.id) throw new Error('no user');
      return leaveMmChannel(token, channelId, user.id);
    },
    onSuccess: () => {
      // Dismiss the sheet first, then replace the chat-detail screen
      // under it with the chats list so the user doesn't land back on
      // a now-stale chat view. Same back-then-push pattern that
      // ``new-channel.tsx`` uses for sheet→navigate transitions.
      router.back();
      setTimeout(() => {
        router.replace('/(tabs)/chats');
      }, 50);
    },
    onError: (err) => {
      Alert.alert(
        'Could not leave channel',
        err instanceof Error ? err.message : 'Try again in a moment.',
      );
    },
  });

  const confirmLeave = useCallback(() => {
    if (!channel) return;
    const title = isDirect
      ? channel.display_name ?? channel.name
      : formatChannelTitle(channel.display_name ?? channel.name);
    Alert.alert(
      `Leave ${title}?`,
      "You'll no longer receive messages or notifications from this channel.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: () => leaveMutation.mutate(),
        },
      ],
    );
  }, [channel, isDirect, leaveMutation]);

  const openAddMember = useCallback(() => {
    if (!channelId) return;
    router.push({
      pathname: '/add-channel-member/[channelId]',
      params: { channelId },
    });
  }, [channelId]);

  const openSearch = useCallback(() => {
    // Search is a first-class tab now — dismiss this sheet, then switch to it.
    router.back();
    setTimeout(() => router.navigate('/search'), 50);
  }, []);

  const toggleMute = useCallback(() => {
    if (!channelId) return;
    muteMutation.mutate({ nextMuted: !isMuted });
  }, [channelId, isMuted, muteMutation]);

  return useMemo(() => {
    if (!channel) return [];

    const placeholder = () => {
      // Search / Pin / Block are visual-only for now — they don't
      // have a server endpoint we can hit, so the press does nothing.
      // ``disabled: true`` dims the tile to telegraph this.
    };

    const muteAction: DetailsAction = {
      key: 'mute',
      symbol: isMuted
        ? { ios: 'bell.fill', android: 'notifications' }
        : { ios: 'bell.slash.fill', android: 'notifications_off' },
      label: isMuted ? 'Unmute' : 'Mute',
      onPress: toggleMute,
      loading: muteMutation.isPending,
    };

    const searchAction: DetailsAction = {
      key: 'search',
      symbol: { ios: 'magnifyingglass', android: 'search' },
      label: 'Search',
      onPress: openSearch,
    };

    if (isDirect) {
      return [
        muteAction,
        searchAction,
        {
          key: 'block',
          symbol: { ios: 'hand.raised.fill', android: 'block' },
          label: 'Block',
          onPress: placeholder,
          destructive: true,
          disabled: true,
        },
      ];
    }

    return [
      muteAction,
      searchAction,
      {
        key: 'pin',
        symbol: { ios: 'pin.fill', android: 'push_pin' },
        label: 'Pin',
        onPress: placeholder,
        disabled: true,
      },
      {
        key: 'add',
        symbol: { ios: 'person.fill.badge.plus', android: 'person_add' },
        label: 'Add',
        onPress: openAddMember,
      },
      {
        key: 'leave',
        symbol: { ios: 'rectangle.portrait.and.arrow.right', android: 'logout' },
        label: 'Leave',
        onPress: confirmLeave,
        destructive: true,
        loading: leaveMutation.isPending,
      },
    ];
  }, [
    channel,
    isDirect,
    isMuted,
    toggleMute,
    muteMutation.isPending,
    openAddMember,
    openSearch,
    confirmLeave,
    leaveMutation.isPending,
  ]);
}

function patchChannelMuted(
  prev: ChannelsCache | undefined,
  channelId: string,
  muted: boolean,
): ChannelsCache | undefined {
  if (!prev) return prev;
  if (!prev.channels.some((c) => c.channel_id === channelId)) return prev;
  return {
    ...prev,
    channels: prev.channels.map((c) =>
      c.channel_id === channelId ? { ...c, muted } : c,
    ),
  };
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const styles = StyleSheet.create({
  actionRowWrap: {
    marginTop: 20,
  },
  heroSkeleton: {
    borderRadius: 24,
    height: 240,
  },
  infoCardWrap: {
    marginTop: 20,
  },
  pagerRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
  },
  pagerViewport: {
    overflow: 'hidden',
  },
  scroll: {
    paddingBottom: Platform.OS === 'ios' ? 32 : 48,
    paddingHorizontal: 16,
    // Top padding kept generous on iOS so the hero card sits well clear
    // of the form-sheet handle (the iOS native grabber lives ~10pt
    // above this) — without the breathing room the card crowds the top
    // edge and the sheet reads as cramped. Android's drawn grabber
    // ([[sheet-grabber]]) takes ~16pt of its own; total Android offset
    // becomes ~28+16=44.
    paddingTop: 28,
  },
  tabContent: {
    marginTop: 16,
  },
  tabsWrap: {
    marginTop: 24,
  },
});

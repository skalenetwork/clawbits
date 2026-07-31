import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { Link, router, Stack } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useState } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// eslint-disable-next-line import/no-unresolved -- ships as source-only; resolved at bundle time via the `react-native` package.json field.
import { ContextMenuView } from 'react-native-ios-context-menu';

import { ChannelRow } from '@/components/channel-row';
import { GlassPill } from '@/components/glass-pill';
import { RealtimeStatusDot } from '@/components/realtime-status-dot';
import { SignInEmptyState } from '@/components/sign-in-empty-state';
import { ChannelListSkeleton } from '@/components/skeletons/channel-row-skeleton';
import { useChannels } from '@/hooks/use-channels';
import { usePinChannel } from '@/hooks/use-pin-channel';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import { useTheme } from '@/hooks/use-theme';
import { type MmChannel } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

const CHAT_TABS = [
  {
    value: 'dms',
    label: 'DMs',
    symbol: { ios: 'person.2.fill', android: 'forum' },
  },
  {
    value: 'channels',
    label: 'Channels',
    symbol: { ios: 'number', android: 'tag' },
  },
] as const;

interface ChannelListPaneProps {
  /** Active channel id — drives the highlighted row at medium+. Leave
   *  undefined in single-pane mode where the detail screen is pushed
   *  on top and "selected" isn't a meaningful state. */
  selectedChannelId?: string;
  /**
   *  Where this pane sits in the layout:
   *   - ``screen`` — it's the sole content of a Stack screen. The
   *     parent Stack header is configured via ``Stack.Screen`` here.
   *   - ``sidebar`` — it's the left column of a two-pane layout. An
   *     inline header is rendered at the top.
   */
  variant: 'screen' | 'sidebar';
  /**
   *  Explicit pixel width of the pane, used to size the swipe-paging
   *  between DMs / Channels. Required for ``sidebar`` (where the pane
   *  is narrower than the device); defaults to the device width for
   *  ``screen``.
   */
  paneWidth?: number;
}

/**
 *  The chats list (DMs + Channels with swipe-paging between them).
 *  Reused in two contexts:
 *
 *   - At ``compact``: rendered full-width by ``chats/index.tsx`` with a
 *     Stack header above it (``variant="screen"``).
 *   - At ``medium+``: rendered in a fixed-width left column by
 *     ``chats/_layout.tsx``, with the chat detail Stack on the right
 *     (``variant="sidebar"``). Inline header is rendered at the top
 *     since the surrounding Stack header doesn't apply to the column.
 */
export function ChannelListPane({
  selectedChannelId,
  variant,
  paneWidth,
}: ChannelListPaneProps) {
  const theme = useTheme();
  const { status } = useAuth();
  const insets = useSafeAreaInsets();
  const stackHeaderHeight = useHeaderHeight();
  const { width: deviceWidth } = useWindowDimensions();
  const width = paneWidth ?? deviceWidth;
  const [selectedTabIndex, setSelectedTabIndex] = useState(0);
  const [pageTranslateX] = useState(() => new Animated.Value(0));
  // In ``screen`` mode the Stack header is transparent on both platforms,
  // so the floating tab bar needs to clear it. iOS keeps the hand-tuned
  // ``insets.top + 52`` (status bar + header + a touch of breathing room);
  // Android uses ``useHeaderHeight`` which already folds in the status bar.
  // In ``sidebar`` mode the inline header is rendered just above; the
  // floating tabs sit immediately below it.
  const headerOffset =
    variant === 'sidebar'
      ? 0
      : Platform.OS === 'ios'
        ? insets.top + 52
        : stackHeaderHeight;
  const { selectedOrg, isLoading: orgsLoading, error: orgsError } = useSelectedOrg();
  const orgId = selectedOrg?.org_id ?? null;
  const channels = useChannels(orgId);
  const showChannelTabs = status === 'authenticated';

  const changeTab = (index: number) => {
    const nextIndex = Math.max(0, Math.min(CHAT_TABS.length - 1, index));
    setSelectedTabIndex(nextIndex);
    Animated.spring(pageTranslateX, {
      toValue: -nextIndex * width,
      useNativeDriver: true,
      bounciness: 0,
      speed: 18,
    }).start();
  };

  const swipeResponder = PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => {
      const absX = Math.abs(gestureState.dx);
      const absY = Math.abs(gestureState.dy);
      return absX > 18 && absX > absY * 1.25;
    },
    onPanResponderGrant: () => {
      pageTranslateX.stopAnimation();
    },
    onPanResponderMove: (_, gestureState) => {
      const baseX = -selectedTabIndex * width;
      const nextX = Math.max(-width, Math.min(0, baseX + gestureState.dx));
      pageTranslateX.setValue(nextX);
    },
    onPanResponderRelease: (_, gestureState) => {
      const shouldMoveLeft = gestureState.dx < -width * 0.22 || gestureState.vx < -0.55;
      const shouldMoveRight = gestureState.dx > width * 0.22 || gestureState.vx > 0.55;
      const currentIndex = selectedTabIndex;
      if (shouldMoveLeft) {
        changeTab(currentIndex + 1);
      } else if (shouldMoveRight) {
        changeTab(currentIndex - 1);
      } else {
        changeTab(currentIndex);
      }
    },
    onPanResponderTerminate: () => {
      changeTab(selectedTabIndex);
    },
    onPanResponderTerminationRequest: () => true,
  });

  let body: React.ReactNode;
  if (status === 'anonymous') {
    body = (
      <View style={styles.center}>
        <SignInEmptyState
          symbol={{ ios: 'bubble.left.and.bubble.right.fill', android: 'chat_bubble' }}
          title="Chat on Clawbits"
          subtitle="Talk to your AI agents and tools, all in one place."
        />
      </View>
    );
  } else if (orgsLoading || channels.isLoading) {
    body = <ChannelListSkeleton />;
  } else if (orgsError || channels.error) {
    const message = orgsError?.message ?? channels.error?.message ?? 'Failed to load chats';
    body = (
      <View style={styles.errorBlock}>
        <Text style={[styles.errorTitle, { color: theme.text }]}>Could not load chats</Text>
        <Text style={[styles.errorText, { color: theme.textSecondary }]} selectable>
          {message}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void channels.refetch();
          }}
          style={({ pressed }) => [
            styles.retryButton,
            {
              backgroundColor: theme.backgroundElement,
              opacity: pressed ? 0.85 : 1,
            },
          ]}>
          <Text style={[styles.retryButtonText, { color: theme.text }]}>Retry</Text>
        </Pressable>
      </View>
    );
  } else {
    const allChannels = channels.data?.channels ?? [];
    const dmChannels = allChannels.filter((channel) => channel.channel_type === 'direct');
    const regularChannels = allChannels.filter((channel) => channel.channel_type !== 'direct');

    body = (
      <View style={styles.swipeArea} {...swipeResponder.panHandlers}>
        <Animated.View
          style={[
            styles.pagesRow,
            {
              width: width * CHAT_TABS.length,
              transform: [{ translateX: pageTranslateX }],
            },
          ]}>
          <View style={[styles.page, { width }]}>
            <ChannelsList
              channels={dmChannels}
              selectedChannelId={selectedChannelId}
              replaceOnSelect={variant === 'sidebar'}
              emptyTitle="No DMs yet"
              emptySubtitle="Direct messages will show here."
            />
          </View>
          <View style={[styles.page, { width }]}>
            <ChannelsList
              channels={regularChannels}
              selectedChannelId={selectedChannelId}
              replaceOnSelect={variant === 'sidebar'}
              emptyTitle="No channels yet"
              emptySubtitle="Channels will show here."
            />
          </View>
        </Animated.View>
      </View>
    );
  }

  return (
    <>
      {variant === 'screen' ? (
        <Stack.Screen
          options={{
            headerTitle: () => <ChatsTitle />,
            // Hide the search / compose pill while the user is signed
            // out — those actions all gate on auth, so showing them on
            // the sign-in empty state would invite taps that lead
            // nowhere. Same reasoning as the conditional headerRight on
            // home & settings.
            headerRight: showChannelTabs
              ? () => <ChatsHeaderRight selectedTabIndex={selectedTabIndex} />
              : undefined,
          }}
        />
      ) : null}
      <View style={[styles.screen, { backgroundColor: theme.background }]}>
        {variant === 'sidebar' ? (
          <View
            style={[
              styles.inlineHeader,
              {
                paddingTop: insets.top + 8,
                borderBottomColor: theme.backgroundSelected,
              },
            ]}>
            <ChatsTitle />
            {showChannelTabs ? (
              <ChatsHeaderRight selectedTabIndex={selectedTabIndex} />
            ) : null}
          </View>
        ) : null}
        <View style={styles.body}>{body}</View>
        {showChannelTabs ? (
          <View
            pointerEvents="box-none"
            style={[styles.channelTabs, { paddingTop: headerOffset }]}>
            <ChatTabsBar selectedIndex={selectedTabIndex} onChange={changeTab} />
          </View>
        ) : null}
      </View>
    </>
  );
}

function ChatsTitle() {
  const theme = useTheme();
  return (
    <View style={styles.titleSlot}>
      <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
        Chats
      </Text>
      <RealtimeStatusDot />
    </View>
  );
}

function ChatsHeaderRight({ selectedTabIndex }: { selectedTabIndex: number }) {
  const isDmsTab = CHAT_TABS[selectedTabIndex]?.value === 'dms';
  return (
    <GlassPill
      actions={[
        {
          symbol: { ios: 'square.grid.2x2', android: 'grid_view' },
          accessibilityLabel: 'Browse channels',
          onPress: () => router.push('/browse-channels'),
        },
        {
          symbol: { ios: 'plus', android: 'add' },
          accessibilityLabel: isDmsTab ? 'New direct message' : 'New channel',
          onPress: () => router.push(isDmsTab ? '/new-dm' : '/new-channel'),
        },
      ]}
    />
  );
}

function ChannelsList({
  channels,
  selectedChannelId,
  replaceOnSelect,
  emptyTitle,
  emptySubtitle,
}: {
  channels: MmChannel[];
  selectedChannelId?: string;
  /** Use ``replace`` instead of ``push`` so the right-pane Stack in
   *  two-pane mode doesn't accumulate a deep history of previously
   *  viewed chats — back from a chat goes straight to the empty state. */
  replaceOnSelect?: boolean;
  emptyTitle: string;
  emptySubtitle: string;
}) {
  const theme = useTheme();

  if (channels.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={[styles.errorTitle, { color: theme.text }]}>{emptyTitle}</Text>
        <Text style={[styles.errorText, { color: theme.textSecondary }]}>{emptySubtitle}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={channels}
      keyExtractor={(item) => item.channel_id}
      contentInsetAdjustmentBehavior="automatic"
      scrollIndicatorInsets={{ top: 54 }}
      contentContainerStyle={styles.listContent}
      renderItem={({ item, index }) => (
        <ChannelCell
          channel={item}
          isFirst={index === 0}
          isLast={index === channels.length - 1}
          isActive={selectedChannelId === item.channel_id}
          replaceOnSelect={replaceOnSelect}
        />
      )}
    />
  );
}

/**
 * One row in the chats list. Splits out from ``ChannelsList`` so the
 * pin/unpin mutation hook lives at the cell level (one mutation per
 * row's render lifecycle), and the iOS context-menu + Android long-press
 * fallback are colocated with the row they act on.
 *
 * On iOS, the cell is wrapped in ``ContextMenuView`` to surface the
 * native long-press menu the rest of the app uses (see
 * ``message-bubble-menu``). On Android, ``ActionSheetIOS`` doesn't
 * exist, so we use ``Alert.alert`` with two buttons — minimal UI, but
 * functionally identical: long-press to pin/unpin.
 */
function ChannelCell({
  channel,
  isFirst,
  isLast,
  isActive,
  replaceOnSelect,
}: {
  channel: MmChannel;
  isFirst: boolean;
  isLast: boolean;
  isActive: boolean;
  replaceOnSelect?: boolean;
}) {
  const theme = useTheme();
  const isPinned = !!channel.pinned;
  const { toggle } = usePinChannel(channel.channel_id);
  const togglePin = () => toggle(isPinned);

  const onLongPressAndroid = () => {
    Alert.alert(channel.display_name ?? channel.name, undefined, [
      {
        text: isPinned ? 'Unpin' : 'Pin',
        onPress: togglePin,
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const cellInner = (
    <Link
      href={{ pathname: '/chats/[channelId]', params: { channelId: channel.channel_id } }}
      replace={replaceOnSelect}
      asChild>
      <Pressable
        onLongPress={Platform.OS === 'android' ? onLongPressAndroid : undefined}
        style={({ pressed }) => [
          styles.cell,
          {
            backgroundColor: pressed || isActive
              ? theme.backgroundSelected
              : theme.backgroundElement,
          },
          isFirst && styles.firstCell,
          isLast && styles.lastCell,
        ]}>
        <ChannelRow channel={channel} />
        {!isLast ? (
          <View
            style={[
              styles.divider,
              { backgroundColor: theme.backgroundSelected },
            ]}
          />
        ) : null}
      </Pressable>
    </Link>
  );

  if (Platform.OS !== 'ios') {
    return cellInner;
  }

  return (
    <ContextMenuView
      menuConfig={{
        menuTitle: '',
        menuItems: [
          {
            actionKey: 'toggle-pin',
            actionTitle: isPinned ? 'Unpin' : 'Pin',
            icon: {
              type: 'IMAGE_SYSTEM',
              imageValue: { systemName: isPinned ? 'pin.slash' : 'pin' },
            },
          },
        ],
      }}
      onPressMenuItem={({ nativeEvent }) => {
        if (nativeEvent.actionKey === 'toggle-pin') {
          togglePin();
        }
      }}>
      {cellInner}
    </ContextMenuView>
  );
}


function ChatTabsBar({
  selectedIndex,
  onChange,
}: {
  selectedIndex: number;
  onChange: (index: number) => void;
}) {
  const theme = useTheme();

  const content = (
    <View style={styles.tabRow}>
      {CHAT_TABS.map((tab, index) => {
        const selected = selectedIndex === index;
        const selectedTint = `${theme.text}18`;
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(index)}
            style={({ pressed }) => [
              styles.tabButton,
              selected && { backgroundColor: selectedTint },
              pressed && styles.pressed,
            ]}>
            <SymbolView
              name={tab.symbol}
              size={17}
              tintColor={selected ? theme.text : theme.textSecondary}
              weight="semibold"
              style={styles.tabIcon}
            />
            <Text
              style={[
                styles.tabLabel,
                { color: selected ? theme.text : theme.textSecondary },
              ]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  if (process.env.EXPO_OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView glassEffectStyle="regular" isInteractive style={styles.tabsGlass}>
        {content}
      </GlassView>
    );
  }

  if (process.env.EXPO_OS === 'ios') {
    return (
      <BlurView tint="systemChromeMaterial" intensity={90} style={styles.tabsGlass}>
        {content}
      </BlurView>
    );
  }

  return (
    <View style={[styles.tabsGlass, { backgroundColor: theme.backgroundElement }]}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
  cell: {
    overflow: 'hidden',
  },
  channelTabs: {
    left: 0,
    paddingBottom: 10,
    paddingHorizontal: 16,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 10,
  },
  center: {
    alignItems: 'center',
    flex: 1,
    gap: 8,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 70,
  },
  errorBlock: {
    alignItems: 'center',
    flex: 1,
    gap: 12,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  errorText: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  firstCell: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  inlineHeader: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
    paddingBottom: 10,
    paddingHorizontal: 16,
  },
  lastCell: {
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingTop: 50,
  },
  page: {
    flex: 1,
  },
  pagesRow: {
    flex: 1,
    flexDirection: 'row',
  },
  pressed: {
    opacity: 0.72,
  },
  retryButton: {
    alignItems: 'center',
    borderRadius: 12,
    minHeight: 44,
    paddingHorizontal: 18,
  },
  retryButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  screen: {
    flex: 1,
  },
  swipeArea: {
    flex: 1,
    overflow: 'hidden',
  },
  tabButton: {
    alignItems: 'center',
    borderRadius: 999,
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 34,
  },
  tabIcon: {
    height: 17,
    width: 17,
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  tabRow: {
    flexDirection: 'row',
    gap: 5,
    padding: 5,
  },
  tabsGlass: {
    borderRadius: 999,
    minHeight: 44,
    overflow: 'hidden',
    width: '100%',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  titleSlot: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    width: '100%',
  },
});

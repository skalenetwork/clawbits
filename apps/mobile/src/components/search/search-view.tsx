import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { SymbolView } from 'expo-symbols';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { SearchDock, SearchPill, SEARCH_BAR_REST } from '@/components/search/search-dock';
import { useChannels } from '@/hooks/use-channels';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import { useTheme } from '@/hooks/use-theme';
import {
  createOrGetMmDirect,
  listOrgAgents,
  listOrgMembers,
  searchMessages,
  type AgentUser,
  type MmChannel,
  type MmMemberType,
  type MmSearchResult,
  type MmSearchSort,
  type OrgMember,
} from '@/lib/api';
import { formatChannelTitle, formatRelativeTime } from '@/lib/formatting';
import { nameMatchScore } from '@/lib/fuzzy';
import { consumePendingSearchFocus } from '@/lib/search-focus';
import { hasActiveFilters, parseSearchQuery, type SearchSources } from '@/lib/search-query';
import { useAuth } from '@/providers/auth-provider';

const MESSAGE_INITIAL = 20;
const MESSAGE_STEP = 20;
const MESSAGE_MAX = 100;
const NAME_GROUP_CAP = 6;
const RECENTS_CAP = 7;
const MIN_MESSAGE_QUERY = 2;
const DEBOUNCE_MS = 200;

type NameKind = 'dm' | 'channel' | 'person' | 'agent';

const NAME_GROUP_LABEL: Record<NameKind, string> = {
  dm: 'Direct messages',
  channel: 'Channels',
  person: 'People',
  agent: 'Agents',
};
const NAME_GROUP_ORDER: readonly NameKind[] = ['dm', 'channel', 'person', 'agent'];

interface NameItem {
  kind: NameKind;
  key: string;
  title: string;
  subtitle: string;
  avatarUrl?: string | null;
  /** Strings the query is fuzzy-matched against. */
  searchText: string[];
  /** Set for dm/channel kinds — the conversation to open. */
  channel?: MmChannel;
  /** Set for person/agent kinds — the peer to start/open a DM with. */
  dmTargetType?: MmMemberType;
  dmTargetId?: string;
}

type Row =
  | { type: 'sectionHeader'; key: string; title: string }
  | { type: 'name'; key: string; item: NameItem }
  | { type: 'messagesHeader'; key: string }
  | { type: 'message'; key: string; item: MmSearchResult }
  | { type: 'status'; key: string; text: string; spinner?: boolean }
  | { type: 'showMore'; key: string };

const HIGHLIGHT_SPLIT = /(<mark>[\s\S]*?<\/mark>)/g;
const HIGHLIGHT_INNER = /^<mark>([\s\S]*?)<\/mark>$/;
const HTML_ENTITY: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function unescapeHtml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => HTML_ENTITY[m] ?? m);
}

/** Render a server snippet that wraps matched terms in ``<mark>…</mark>``.
 *  We split on the markers and render the inner text as styled <Text> — never
 *  inject as HTML (the markers are the only HTML; surrounding text is escaped
 *  by Postgres, which we unescape here). */
function Highlight({ snippet }: { snippet: string }) {
  const theme = useTheme();
  const parts = snippet.split(HIGHLIGHT_SPLIT);
  return (
    <Text style={[styles.snippet, { color: theme.textSecondary }]} numberOfLines={2}>
      {parts.map((part, i) => {
        if (!part) return null;
        const marked = HIGHLIGHT_INNER.exec(part);
        if (marked) {
          return (
            <Text key={i} style={[styles.mark, { color: theme.text }]}>
              {unescapeHtml(marked[1] ?? '')}
            </Text>
          );
        }
        return <Text key={i}>{unescapeHtml(part)}</Text>;
      })}
    </Text>
  );
}

/**
 * The Search tab body — a first-class search surface (Apple Music style): a
 * large "Search" title + field, an instant name tier (channels / people /
 * agents from the loaded caches), and a debounced server message tier with
 * operator chips, a Relevant/Recent toggle, and result highlighting. Tapping a
 * result navigates into the Chats tab (and jumps to the exact message).
 */
export function SearchView() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const androidHeaderPad = Platform.OS === 'android' ? headerHeight : 0;
  // Resting clearance: floats the bar just above the tab bar (keyboard closed).
  const restClearance = insets.bottom + SEARCH_BAR_REST;
  // Measured floating-bar height — drives the list's bottom inset so results
  // never hide behind the bar (grows with the chips row).
  const [barHeight, setBarHeight] = useState(72);

  // Focus the field when we arrive from the Home search bar (which sets a
  // pending-focus flag then navigates here). Tied to the tab's focus event so
  // it fires whether or not this tab was already mounted.
  const inputRef = useRef<TextInput>(null);
  useFocusEffect(
    useCallback(() => {
      if (!consumePendingSearchFocus()) return undefined;
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }, []),
  );
  const { token, user } = useAuth();
  const { selectedOrg } = useSelectedOrg();
  const queryClient = useQueryClient();
  const orgId = selectedOrg?.org_id ?? null;

  const [rawQuery, setRawQuery] = useState('');
  const [messageSort, setMessageSort] = useState<MmSearchSort>('relevant');
  const [messageLimit, setMessageLimit] = useState(MESSAGE_INITIAL);
  const [pendingDm, setPendingDm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const debouncedRaw = useDebouncedValue(rawQuery, DEBOUNCE_MS);

  const channelsQuery = useChannels(orgId);
  const membersQuery = useQuery({
    queryKey: ['org-members', orgId],
    queryFn: () => listOrgMembers(token, orgId!),
    enabled: token != null && orgId != null,
  });
  const agentsQuery = useQuery({
    queryKey: ['org-agents', orgId],
    queryFn: () => listOrgAgents(token, orgId!),
    enabled: token != null && orgId != null,
  });

  const channels = useMemo(() => channelsQuery.data?.channels ?? [], [channelsQuery.data]);
  const members = useMemo(() => membersQuery.data?.members ?? [], [membersQuery.data]);
  const agents = useMemo(() => agentsQuery.data?.agents ?? [], [agentsQuery.data]);

  const sources = useMemo<SearchSources>(
    () => ({ channels, members, agents }),
    [channels, members, agents],
  );

  // Live parse drives the instant name tier + chips; the debounced parse drives
  // the server message query so we don't fire a request per keystroke.
  const parsed = useMemo(() => parseSearchQuery(rawQuery, sources), [rawQuery, sources]);
  const debParsed = useMemo(() => parseSearchQuery(debouncedRaw, sources), [debouncedRaw, sources]);

  const msgText = debParsed.text;
  const msgFilters = debParsed.filters;
  const msgActive = msgText.trim().length >= MIN_MESSAGE_QUERY || hasActiveFilters(msgFilters);

  const messagesQuery = useQuery({
    queryKey: [
      'mm-search',
      orgId,
      msgText,
      messageSort,
      JSON.stringify(msgFilters),
      messageLimit,
    ],
    queryFn: () =>
      searchMessages(token, {
        orgId,
        query: msgText,
        sort: messageSort,
        limit: messageLimit,
        channelId: msgFilters.channelId,
        fromHumanId: msgFilters.fromHumanId,
        fromAgentId: msgFilters.fromAgentId,
        before: msgFilters.before,
        after: msgFilters.after,
        hasLink: msgFilters.hasLink,
        hasFile: msgFilters.hasFile,
      }),
    enabled: token != null && orgId != null && msgActive,
    staleTime: 30_000,
  });

  // Only trust results the server echoes back for the *current* query text,
  // so a slower in-flight response can't flash the previous query's hits.
  const messagesValid =
    messagesQuery.data != null && messagesQuery.data.query.trim() === msgText.trim();
  const messageResults = useMemo<MmSearchResult[]>(
    () => (messagesValid && messagesQuery.data ? messagesQuery.data.results : []),
    [messagesValid, messagesQuery.data],
  );
  const pendingDebounce = rawQuery.trim() !== debouncedRaw.trim();
  const messagesError = messagesQuery.isError;
  const messagesLoading =
    msgActive && !messagesError && (pendingDebounce || messagesQuery.isFetching || !messagesValid);
  const hasMore =
    messagesValid && messagesQuery.data!.next_cursor != null && messageLimit < MESSAGE_MAX;

  const resetMessagePaging = () => setMessageLimit(MESSAGE_INITIAL);

  // Build the name-tier universe. DMs resolve their peer (human or agent) from
  // the already-loaded member/agent lists — so a 1:1 DM shows the peer's real
  // name + avatar (not the channel marble or a "Channel" label), with no extra
  // per-channel fetch — and people/agents who already have a DM are dropped so
  // they appear once. Mirrors the web CommandPalette's nameItems.
  const nameItems = useMemo<NameItem[]>(() => {
    const memberById = new Map<number, OrgMember>(members.map((m) => [m.human_id, m]));
    const agentById = new Map<string, AgentUser>(agents.map((a) => [a.agent_id, a]));
    const dmHumanIds = new Set<number>();
    const dmAgentIds = new Set<string>();

    const channelItems = channels.map<NameItem>((c) => {
      const isDm = c.channel_type === 'direct';
      const peerHumanId = isDm ? c.dm_peer_human_id ?? null : null;
      const peerAgentId = isDm ? c.dm_peer_agent_id ?? null : null;
      if (peerHumanId != null) dmHumanIds.add(peerHumanId);
      if (peerAgentId != null) dmAgentIds.add(peerAgentId);
      const peerHuman = peerHumanId != null ? memberById.get(peerHumanId) : undefined;
      const peerAgent = peerAgentId != null ? agentById.get(peerAgentId) : undefined;

      if (isDm) {
        const title =
          peerHuman?.display_name ??
          peerHuman?.email ??
          peerAgent?.display_name ??
          peerAgent?.nickname ??
          peerAgent?.agent_id ??
          (c.display_name ?? c.name);
        return {
          kind: 'dm',
          key: `dm-${c.channel_id}`,
          title,
          subtitle: peerAgent ? 'Agent' : 'Direct message',
          // Prefer the peer's real avatar; fall back to the channel marble.
          avatarUrl: peerHuman?.avatar?.url ?? peerAgent?.avatar?.url ?? c.avatar?.url,
          searchText: [title],
          channel: c,
        };
      }

      const title = formatChannelTitle(c.display_name ?? c.name);
      return {
        kind: 'channel',
        key: `ch-${c.channel_id}`,
        title,
        subtitle: c.channel_type === 'private' ? 'Private channel' : 'Channel',
        avatarUrl: c.avatar?.url,
        searchText: [title, c.name],
        channel: c,
      };
    });

    const people = members
      .filter((m) => m.human_id !== user?.id && !dmHumanIds.has(m.human_id))
      .map<NameItem>((m) => ({
        kind: 'person',
        key: `hu-${String(m.human_id)}`,
        title: m.display_name ?? m.email,
        subtitle: m.email,
        avatarUrl: m.avatar?.url,
        searchText: [m.display_name ?? '', m.email],
        dmTargetType: 'human',
        dmTargetId: String(m.human_id),
      }));

    const agentItems = agents
      .filter((a) => !dmAgentIds.has(a.agent_id))
      .map<NameItem>((a) => ({
        kind: 'agent',
        key: `ag-${a.agent_id}`,
        title: a.display_name ?? a.nickname ?? a.agent_id,
        subtitle: 'Agent',
        avatarUrl: a.avatar?.url,
        searchText: [a.display_name ?? '', a.nickname ?? '', a.agent_id],
        dmTargetType: 'agent',
        dmTargetId: a.agent_id,
      }));

    return [...channelItems, ...people, ...agentItems];
  }, [channels, members, agents, user?.id]);

  const nameRows = useMemo<Row[]>(() => {
    const text = parsed.text;
    const rows: Row[] = [];

    // Empty query → recent conversations (DMs + channels), newest first.
    if (!text && !hasActiveFilters(parsed.filters)) {
      const recents = nameItems
        .filter((it) => (it.kind === 'dm' || it.kind === 'channel') && it.channel?.last_message_at)
        .sort(
          (a, b) =>
            new Date(b.channel?.last_message_at ?? 0).getTime() -
            new Date(a.channel?.last_message_at ?? 0).getTime(),
        )
        .slice(0, RECENTS_CAP);
      if (recents.length) {
        rows.push({ type: 'sectionHeader', key: 'h-recent', title: 'Recent' });
        for (const it of recents) rows.push({ type: 'name', key: `r-${it.key}`, item: it });
      }
      return rows;
    }

    const scored = nameItems
      .map((it) => ({ it, score: Math.max(0, ...it.searchText.map((t) => nameMatchScore(text, t))) }))
      .filter((x) => x.score > 0);

    for (const kind of NAME_GROUP_ORDER) {
      const items = scored
        .filter((x) => x.it.kind === kind)
        .sort((a, b) => b.score - a.score)
        .slice(0, NAME_GROUP_CAP);
      if (items.length) {
        rows.push({ type: 'sectionHeader', key: `h-${kind}`, title: NAME_GROUP_LABEL[kind] });
        for (const x of items) rows.push({ type: 'name', key: `nm-${x.it.key}`, item: x.it });
      }
    }

    return rows;
  }, [parsed, nameItems]);

  const messageRows = useMemo<Row[]>(() => {
    if (!msgActive) return [];
    const rows: Row[] = [{ type: 'messagesHeader', key: 'h-messages' }];
    if (messageResults.length) {
      for (const r of messageResults) rows.push({ type: 'message', key: `msg-${String(r.post_id)}`, item: r });
      if (hasMore) rows.push({ type: 'showMore', key: 'show-more' });
    } else if (messagesLoading) {
      rows.push({ type: 'status', key: 'msg-loading', text: 'Searching messages…', spinner: true });
    } else if (messagesError) {
      rows.push({ type: 'status', key: 'msg-error', text: 'Search failed. Check your connection.' });
    } else {
      rows.push({ type: 'status', key: 'msg-empty', text: 'No message matches.' });
    }
    return rows;
  }, [msgActive, messageResults, hasMore, messagesLoading, messagesError]);

  const data = useMemo<Row[]>(() => [...nameRows, ...messageRows], [nameRows, messageRows]);

  const openChannel = (channelId: string) => {
    // Navigate (not push) so the channel opens in the Chats tab, mirroring how
    // Home links into a conversation — keeps Search state intact behind it.
    router.navigate({ pathname: '/chats/[channelId]', params: { channelId } });
  };

  const openName = async (item: NameItem) => {
    if ((item.kind === 'dm' || item.kind === 'channel') && item.channel) {
      openChannel(item.channel.channel_id);
      return;
    }
    if (!item.dmTargetType || !item.dmTargetId || !orgId || pendingDm) return;
    setPendingDm(item.key);
    setError(null);
    try {
      const channel = await createOrGetMmDirect(token, orgId, item.dmTargetType, item.dmTargetId);
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
      openChannel(channel.channel_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open conversation");
    } finally {
      setPendingDm(null);
    }
  };

  const openMessage = (item: MmSearchResult) => {
    router.navigate({
      pathname: '/chats/[channelId]',
      params: { channelId: item.channel_id, jumpToPostId: String(item.post_id) },
    });
  };

  const removeChip = (token_: string) => {
    setRawQuery((prev) => prev.replace(token_, '').replace(/\s+/gu, ' ').trim());
    resetMessagePaging();
  };

  const showEmptyHint = data.length === 0;
  const emptyHint =
    rawQuery.trim() === ''
      ? 'Search messages, channels, and people in this workspace.'
      : 'No matches found.';

  const renderItem = ({ item }: { item: Row }) => {
    switch (item.type) {
      case 'sectionHeader':
        return (
          <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>{item.title}</Text>
        );
      case 'name': {
        const n = item.item;
        const busy = pendingDm === n.key;
        return (
          <Pressable
            accessibilityRole="button"
            onPress={() => void openName(n)}
            disabled={pendingDm !== null}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
            <Avatar uri={n.avatarUrl} name={n.title} size={36} />
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                {n.title}
              </Text>
              <Text style={[styles.rowSub, { color: theme.textSecondary }]} numberOfLines={1}>
                {n.subtitle}
              </Text>
            </View>
            {busy ? <ActivityIndicator size="small" color={theme.textSecondary} /> : null}
          </Pressable>
        );
      }
      case 'messagesHeader':
        return (
          <View style={styles.messagesHeader}>
            <Text style={[styles.sectionHeader, styles.messagesTitle, { color: theme.textSecondary }]}>
              Messages
            </Text>
            <View style={[styles.sortToggle, { backgroundColor: theme.backgroundElement }]}>
              {(['relevant', 'recent'] as const).map((s) => {
                const active = messageSort === s;
                return (
                  <Pressable
                    key={s}
                    accessibilityRole="button"
                    onPress={() => {
                      setMessageSort(s);
                      resetMessagePaging();
                    }}
                    style={[styles.sortButton, active && { backgroundColor: theme.backgroundSelected }]}>
                    <Text
                      style={[
                        styles.sortLabel,
                        { color: active ? theme.text : theme.textSecondary },
                      ]}>
                      {s === 'relevant' ? 'Relevant' : 'Recent'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      case 'message': {
        const r = item.item;
        const authorName = r.author.display_name ?? (r.author.kind === 'agent' ? 'Agent' : 'Someone');
        const channelLabel =
          r.channel_type === 'direct'
            ? 'Direct message'
            : r.channel_display_name
              ? formatChannelTitle(r.channel_display_name)
              : 'Channel';
        return (
          <Pressable
            accessibilityRole="button"
            onPress={() => openMessage(r)}
            style={({ pressed }) => [styles.row, styles.messageRow, pressed && styles.rowPressed]}>
            <Avatar uri={r.author.avatar?.url} name={authorName} size={36} />
            <View style={styles.rowBody}>
              <View style={styles.messageMeta}>
                <Text style={[styles.rowTitle, styles.messageAuthor, { color: theme.text }]} numberOfLines={1}>
                  {authorName}
                </Text>
                <Text style={[styles.messageChannel, { color: theme.textSecondary }]} numberOfLines={1}>
                  {`in ${channelLabel}`}
                </Text>
                <Text style={[styles.messageTime, { color: theme.textSecondary }]} numberOfLines={1}>
                  {formatRelativeTime(r.created_at)}
                </Text>
              </View>
              <Highlight snippet={r.snippet} />
            </View>
          </Pressable>
        );
      }
      case 'showMore':
        return (
          <Pressable
            accessibilityRole="button"
            onPress={() => setMessageLimit((n) => Math.min(n + MESSAGE_STEP, MESSAGE_MAX))}
            style={({ pressed }) => [styles.showMore, pressed && styles.rowPressed]}>
            <Text style={[styles.showMoreText, { color: theme.text }]}>Show more results</Text>
          </Pressable>
        );
      case 'status':
        return (
          <View style={styles.status}>
            {item.spinner ? <ActivityIndicator size="small" color={theme.textSecondary} /> : null}
            <Text style={[styles.statusText, { color: theme.textSecondary }]}>{item.text}</Text>
          </View>
        );
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <FlatList
        data={data}
        keyExtractor={(row) => row.key}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        // Scroll under the transparent native header like the other tabs.
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingTop: androidHeaderPad + 4,
          // Clear the tab bar + the floating search bar resting above it.
          paddingBottom: restClearance + barHeight + 16,
        }}
        ListEmptyComponent={
          showEmptyHint ? (
            <Text style={[styles.emptyHint, { color: theme.textSecondary }]}>{emptyHint}</Text>
          ) : null
        }
      />

      {/* Floating search bar: rests just above the tab bar and rises to sit on
          top of the keyboard when focused. Content scrolls underneath it.
          Placement + capsule are shared with Home via ``SearchDock``. */}
      <SearchDock onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}>
        {parsed.chips.length > 0 ? (
          <View style={styles.chipsRow}>
            {parsed.chips.map((chip) => (
              <Pressable
                key={chip.id}
                accessibilityRole="button"
                accessibilityLabel={`Remove filter ${chip.label}`}
                onPress={() => removeChip(chip.token)}
                style={({ pressed }) => [
                  styles.chip,
                  { backgroundColor: theme.backgroundSelected },
                  pressed && styles.rowPressed,
                ]}>
                <Text style={[styles.chipText, { color: theme.text }]} numberOfLines={1}>
                  {chip.label}
                </Text>
                <SymbolView
                  name={{ ios: 'xmark', android: 'close' }}
                  size={10}
                  tintColor={theme.textSecondary}
                  weight="bold"
                  style={styles.chipClose}
                />
              </Pressable>
            ))}
          </View>
        ) : null}

        {error ? (
          <Text style={[styles.error, { color: theme.destructive }]} selectable>
            {error}
          </Text>
        ) : null}

        <SearchPill>
          <TextInput
            ref={inputRef}
            value={rawQuery}
            onChangeText={(v) => {
              setRawQuery(v);
              setError(null);
              resetMessagePaging();
            }}
            placeholder="Messages, channels, and people"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={[styles.searchInput, { color: theme.text }]}
          />
          {rawQuery.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              hitSlop={10}
              onPress={() => {
                setRawQuery('');
                resetMessagePaging();
              }}>
              <SymbolView
                name={{ ios: 'xmark.circle.fill', android: 'cancel' }}
                tintColor={theme.textSecondary}
                size={16}
              />
            </Pressable>
          ) : null}
        </SearchPill>
      </SearchDock>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    maxWidth: 220,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipClose: {
    marginLeft: 6,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingBottom: 8,
    paddingHorizontal: 4,
  },
  emptyHint: {
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 32,
    paddingVertical: 48,
    textAlign: 'center',
  },
  error: {
    fontSize: 13,
    marginBottom: 8,
    marginHorizontal: 4,
  },
  mark: {
    fontWeight: '700',
  },
  messageAuthor: {
    flexShrink: 1,
  },
  messageChannel: {
    flexShrink: 1,
    fontSize: 13,
  },
  messageMeta: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 6,
  },
  messageRow: {
    alignItems: 'flex-start',
  },
  messageTime: {
    fontSize: 12,
    marginLeft: 'auto',
  },
  messagesHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingRight: 16,
  },
  messagesTitle: {
    marginBottom: 0,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowPressed: {
    opacity: 0.6,
  },
  rowSub: {
    fontSize: 12,
    marginTop: 1,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '500',
  },
  screen: {
    flex: 1,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 0,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: -0.1,
    marginBottom: 4,
    marginTop: 16,
    paddingHorizontal: 16,
  },
  showMore: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  showMoreText: {
    fontSize: 15,
    fontWeight: '600',
  },
  snippet: {
    fontSize: 14,
    lineHeight: 19,
    marginTop: 2,
  },
  sortButton: {
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  sortLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  sortToggle: {
    borderRadius: 9,
    flexDirection: 'row',
    gap: 2,
    padding: 2,
  },
  status: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
  statusText: {
    fontSize: 14,
  },
});

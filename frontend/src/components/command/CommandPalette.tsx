import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import {useNavigate} from "react-router-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {useStore} from "@tanstack/react-store";
import {
    ArrowDown01Icon,
    BookOpen01Icon,
    Cancel01Icon,
    Clock01Icon,
    HashtagIcon,
    Home03Icon,
    LockIcon,
    Message01Icon,
    MessageAdd01Icon,
    Robot02Icon,
    Search01Icon,
    Settings01Icon,
    SparklesIcon,
    UserAdd01Icon,
} from "@hugeicons/core-free-icons";
import type {IconSvgElement} from "@hugeicons/react";
import {Drawer as DrawerPrimitive} from "@base-ui/react/drawer";
import {Dialog, DialogContent, DialogTitle} from "@/components/ui/dialog";
import {Icon} from "@/components/Icon";
import {UserAvatar} from "@/components/UserAvatar";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {useAuth} from "@/context/AuthContext";
import {
    createOrGetMmDirect,
    getAgents,
    listMmChannels,
    listOrgMembers,
    searchMessages,
    type AgentUser,
    type MmChannel,
    type MmSearchResult,
    type MmSearchSort,
    type OrgMember,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {fuzzyScoreAny} from "@/lib/fuzzy";
import {
    frecencyKey,
    frecencyScore,
    loadFrecency,
    recordVisit,
    type FrecencyStore,
} from "@/lib/frecency";
import {formatChannelTitle, formatRelativeShort} from "@/lib/formatting";
import {hasActiveFilters, parseSearchQuery, type SearchSources} from "@/lib/searchQuery";
import {activityTime} from "@/lib/chatFilters";
import {toast} from "@/lib/toast";
import {useShortcut} from "@/lib/shortcuts";
import {useIsMobile} from "@/hooks/use-mobile";
import {
    closeCommandPalette,
    commandPaletteOpenAtom,
    toggleCommandPalette,
} from "./paletteStore";
import {openCreate, type CreateDialogKind} from "./createStore";

type ItemKind = "dm" | "channel" | "person" | "agent" | "action" | "message";

interface PaletteItem {
    key: string;
    kind: ItemKind;
    title: string;
    subtitle?: string;
    /** Strings the query is fuzzy-matched against (name tiers only). */
    searchText: string[];
    /** Frecency lookup key, when the item participates in frecency. */
    frecencyKey?: string;
    avatarUrl?: string | null;
    /** For a human DM: the peer's display name. Drives an initial-letter
     *  avatar fallback so a DM row reads like its "People" counterpart
     *  instead of a blank tile when no avatar image is available. */
    dmPeerName?: string;
    /** For an agent DM: the peer agent's display name. Renders the agent-face
     *  avatar so the row matches its "Agents" counterpart. */
    dmPeerAgentName?: string;
    /** Channel type for the glyph fallback (public/private). */
    channelType?: MmChannel["channel_type"];
    icon?: IconSvgElement;
    /** Tinted tile for an action row (Actions group only). */
    tint?: ActionTint;
    /** Raw server hit, for the "message" kind (custom row rendering). */
    result?: MmSearchResult;
    onSelect: () => void;
}

/** Tinted tile palette for the Actions group — a soft fill + matching glyph
 *  colour, mirroring the rail's create menu. Static class strings so Tailwind
 *  keeps them; the colour is an inline style (survives the active-row tint). */
const ACTION_TINTS = {
    blue: {square: "bg-blue-500/15", color: "var(--color-blue-500)"},
    emerald: {square: "bg-emerald-500/15", color: "var(--color-emerald-500)"},
    violet: {square: "bg-violet-500/15", color: "var(--color-violet-500)"},
    rose: {square: "bg-rose-500/15", color: "var(--color-rose-500)"},
    sky: {square: "bg-sky-500/15", color: "var(--color-sky-500)"},
    slate: {square: "bg-slate-500/15", color: "var(--color-slate-500)"},
    amber: {square: "bg-amber-500/15", color: "var(--color-amber-500)"},
} as const;
type ActionTint = keyof typeof ACTION_TINTS;

const GROUP_LABEL: Record<Exclude<ItemKind, "message">, string> = {
    dm: "Direct messages",
    channel: "Channels",
    person: "People",
    agent: "Agents",
    action: "Actions",
};

const GROUP_ORDER: Exclude<ItemKind, "message">[] = ["dm", "channel", "person", "agent", "action"];
const PER_GROUP_CAP = 6;
const RECENTS_CAP = 7;
const MESSAGE_CAP = 8;
const MIN_MESSAGE_QUERY = 2;

/** The verb shown in the active row's "↵" action hint, per item kind. */
const ACTION_VERB: Record<ItemKind, string> = {
    channel: "Jump to",
    dm: "Open",
    person: "Message",
    agent: "Message",
    action: "Open",
    message: "Jump to",
};

/** Avatar / glyph tile for a name-tier palette row — a consistent 30px square.
 *  Icons sit in a subtly inset "well"; avatars get a hairline ring. */
function RowGlyph({item}: {item: PaletteItem}) {
    if (item.kind === "person") {
        return <UserAvatar name={item.title} src={item.avatarUrl} size={30} className="shrink-0 ring-1 ring-foreground/10" />;
    }
    if (item.kind === "agent") {
        return <AgentFaceAvatar name={item.title} src={item.avatarUrl} size={30} className="shrink-0 ring-1 ring-foreground/10" />;
    }
    // A DM renders like its "People"/"Agents" twin — the peer's real avatar
    // with a fallback — so it never falls through to a blank message tile.
    if (item.kind === "dm" && item.dmPeerAgentName) {
        return <AgentFaceAvatar name={item.dmPeerAgentName} src={item.avatarUrl} size={30} className="shrink-0 ring-1 ring-foreground/10" />;
    }
    if (item.kind === "dm" && item.dmPeerName) {
        return <UserAvatar name={item.dmPeerName} src={item.avatarUrl} size={30} className="shrink-0 ring-1 ring-foreground/10" />;
    }
    if ((item.kind === "channel" || item.kind === "dm") && item.avatarUrl) {
        return (
            <img
                src={item.avatarUrl}
                alt=""
                className="cmdk-tile size-[30px] shrink-0 rounded-[9px] object-cover"
            />
        );
    }
    // Action rows get a tinted tile + matching glyph colour (mirrors the rail's
    // create menu) so the Actions group reads as "do something", not "jump to".
    if (item.kind === "action" && item.tint) {
        const t = ACTION_TINTS[item.tint];
        return (
            <span className={`flex size-[30px] shrink-0 items-center justify-center rounded-[9px] ${t.square}`}>
                <Icon icon={item.icon ?? Search01Icon} className="size-[17px]" style={{color: t.color}} />
            </span>
        );
    }
    const glyph =
        item.icon ??
        (item.kind === "dm"
            ? Message01Icon
            : item.channelType === "private"
              ? LockIcon
              : HashtagIcon);
    return (
        <span className="cmdk-tile flex size-[30px] shrink-0 items-center justify-center rounded-[9px] text-muted-foreground">
            <Icon icon={glyph} className="size-[17px]" />
        </span>
    );
}

/**
 * Render a server highlight snippet safely. Postgres ``ts_headline`` wraps
 * matched terms in literal ``<mark>…</mark>`` but does NOT HTML-escape the
 * surrounding text, so we never inject it as HTML — we split on the marker
 * pairs and render each segment as a React text node (escaped). A literal
 * "<mark>" in a message is harmless (a spurious highlight at most).
 */
function Highlight({text}: {text: string}) {
    const segments = text.split(/(<mark>.*?<\/mark>)/g);
    return (
        <>
            {segments.map((seg, i) => {
                const match = /^<mark>(.*)<\/mark>$/s.exec(seg);
                if (match) {
                    return (
                        <mark key={i} className="rounded bg-primary/20 px-0.5 text-foreground">
                            {match[1]}
                        </mark>
                    );
                }
                return seg ? <span key={i}>{seg}</span> : null;
            })}
        </>
    );
}

/**
 * The Cmd/Ctrl+K command palette — one surface for Tier-1 instant name search
 * (channels/DMs/people/agents, client-side) and Tier-2 message-content search
 * (server, streamed in as a "Messages" group without blocking the name tier).
 * Mounted once in the app shell; gated on auth by {@link CommandPalette}. See
 * docs/protocol/SEARCH_SPEC.md.
 */
function CommandPaletteInner() {
    const open = useStore(commandPaletteOpenAtom, (v) => v);
    const {user, activeOrgId} = useAuth();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const isMobile = useIsMobile();

    useShortcut({
        id: "command-palette",
        keys: "$mod+k",
        run: (e) => {
            e.preventDefault();
            toggleCommandPalette();
        },
        hint: {label: "K", group: "Navigation", description: "Search & jump to…"},
        // ⌘K must work even while typing in the message composer.
        allowInEditable: true,
    });

    const [query, setQuery] = useState("");
    const [debounced, setDebounced] = useState("");
    const [activeIndex, setActiveIndex] = useState(0);
    // Frecency snapshot + "now" taken once per open so scores are stable while
    // typing (and so the render stays pure — no Date.now() in useMemo).
    const [frecency, setFrecency] = useState<FrecencyStore>({});
    const [now, setNow] = useState(0);
    // Message-tier controls: sort mode (sticky across queries) + a growable cap
    // for the inline "show more" affordance (reset per query).
    const [messageSort, setMessageSort] = useState<MmSearchSort>("relevant");
    const [messageLimit, setMessageLimit] = useState(MESSAGE_CAP);
    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    // When the palette last opened — used to ignore a spurious close fired by
    // the very interaction that opened it (Base UI's outside-press catching the
    // opening pointer event before the dialog has fully taken over).
    const openedAtRef = useRef(0);

    useEffect(() => {
        if (open) {
            setQuery("");
            setActiveIndex(0);
            setFrecency(loadFrecency());
            setNow(Date.now());
            openedAtRef.current = Date.now();
        }
    }, [open]);

    const trimmed = query.trim();

    // Debounce the query that drives the server message search so we don't
    // fire per keystroke. The name tier below is NOT debounced — it stays
    // instant.
    useEffect(() => {
        const id = setTimeout(() => {
            setDebounced(trimmed);
            setMessageLimit(MESSAGE_CAP); // new query → start from the base cap
        }, 180);
        return () => { clearTimeout(id); };
    }, [trimmed]);

    // Channels are usually warm (sidebar already loaded them); people/agents
    // are fetched on first open, then cached. Tier-1 stays instant on warm
    // caches and degrades gracefully (results stream in) on a cold open.
    const channelsQuery = useQuery({
        queryKey: queryKeys.mm.channels(activeOrgId ?? null),
        queryFn: () => listMmChannels(activeOrgId ?? null),
        enabled: Boolean(activeOrgId) && open,
        staleTime: 60_000,
    });
    const membersQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.orgMembers(activeOrgId) : ["org-members", "none"],
        queryFn: () => listOrgMembers(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && open,
        staleTime: 60_000,
    });
    const agentsQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.agents(activeOrgId) : ["agents", "none"],
        queryFn: () => getAgents(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && open,
        staleTime: 60_000,
    });

    // Parse search operators (from:/in:/before:/after:/has:) out of the query
    // and resolve names → ids against the loaded lists. `parsed` is live (drives
    // the instant name tier + chips); `debParsed` lags the debounce (drives the
    // server message query). See lib/searchQuery.ts.
    const sources = useMemo<SearchSources>(
        () => ({
            channels: channelsQuery.data?.channels ?? [],
            members: membersQuery.data?.members ?? [],
            agents: agentsQuery.data?.agents ?? [],
        }),
        [channelsQuery.data, membersQuery.data, agentsQuery.data],
    );
    const parsed = useMemo(() => parseSearchQuery(query, sources), [query, sources]);
    const debParsed = useMemo(() => parseSearchQuery(debounced, sources), [debounced, sources]);
    const effectiveText = parsed.text;
    const msgText = debParsed.text;
    const msgFilters = debParsed.filters;
    const msgActive = msgText.length >= MIN_MESSAGE_QUERY || hasActiveFilters(msgFilters);

    // Tier-2 message content search (operators applied as filters). A blank
    // text with active filters is a valid filter-only listing.
    const messagesQuery = useQuery({
        queryKey: [
            "mm",
            "search",
            activeOrgId ?? null,
            msgText,
            messageSort,
            JSON.stringify(msgFilters),
            messageLimit,
        ],
        queryFn: () =>
            searchMessages({
                orgId: activeOrgId ?? null,
                query: msgText,
                sort: messageSort,
                limit: messageLimit,
                channelId: msgFilters.channelId ?? null,
                fromHumanId: msgFilters.fromHumanId ?? null,
                fromAgentId: msgFilters.fromAgentId ?? null,
                before: msgFilters.before ?? null,
                after: msgFilters.after ?? null,
                hasLink: msgFilters.hasLink,
                hasFile: msgFilters.hasFile,
            }),
        enabled: Boolean(activeOrgId) && open && msgActive,
        staleTime: 30_000,
    });

    const openDmMutation = useMutation({
        mutationFn: (t: {kind: "human" | "agent"; id: string}) =>
            createOrGetMmDirect(activeOrgId ?? "", t.kind, t.id),
        onSuccess: (channel: MmChannel) => {
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            void navigate(`/channels/${channel.channel_id}`);
        },
        onError: (e: Error) => {
            toast.error(e.message || "Couldn't open that conversation");
        },
    });

    const goToChannel = useCallback(
        (channelId: string) => {
            recordVisit(frecencyKey("channel", channelId));
            closeCommandPalette();
            void navigate(`/channels/${channelId}`);
        },
        [navigate],
    );

    // Open a channel scrolled to a specific message (deep-link). ChannelPage
    // reads ``?msg`` and jumps to + highlights that post.
    const goToMessage = useCallback(
        (channelId: string, postId: number) => {
            recordVisit(frecencyKey("channel", channelId));
            closeCommandPalette();
            void navigate(`/channels/${channelId}?msg=${String(postId)}`);
        },
        [navigate],
    );

    const openConversation = useCallback(
        (kind: "human" | "agent", id: string) => {
            recordVisit(frecencyKey(kind, id));
            closeCommandPalette();
            openDmMutation.mutate({kind, id});
        },
        [openDmMutation],
    );

    const runAction = useCallback(
        (to: string) => {
            closeCommandPalette();
            void navigate(to);
        },
        [navigate],
    );

    // Create actions close the palette, then open the shared create dialog
    // (mounted once in the app shell via CreateDialogs + createStore).
    const runCreate = useCallback((kind: CreateDialogKind) => {
        closeCommandPalette();
        openCreate(kind);
    }, []);

    // --- Name-tier item universe + quick actions ----------------------------
    const nameItems = useMemo<PaletteItem[]>(() => {
        const channels = channelsQuery.data?.channels ?? [];
        const members = membersQuery.data?.members ?? [];
        const agentList = agentsQuery.data?.agents ?? [];
        // Index members + agents by id so a 1:1 DM can borrow the peer's real
        // avatar + name (the channel's generated marble is often absent), and so
        // we can dedupe: someone you already DM with shows once, as the DM.
        const memberById = new Map<number, OrgMember>(members.map((m) => [m.human_id, m] as const));
        const agentById = new Map<string, AgentUser>(agentList.map((a) => [a.agent_id, a] as const));
        const dmPeerHumanIds = new Set<number>();
        const dmPeerAgentIds = new Set<string>();

        const channelItems = channels.map<PaletteItem>((c) => {
            const isDm = c.channel_type === "direct";
            const peerHumanId = isDm ? c.dm_peer_human_id ?? null : null;
            const peerAgentId = isDm ? c.dm_peer_agent_id ?? null : null;
            if (peerHumanId != null) dmPeerHumanIds.add(peerHumanId);
            if (peerAgentId != null) dmPeerAgentIds.add(peerAgentId);
            const peerHuman = peerHumanId != null ? memberById.get(peerHumanId) : undefined;
            const peerAgent = peerAgentId != null ? agentById.get(peerAgentId) : undefined;
            const title = formatChannelTitle(c.display_name ?? c.name, isDm ? "Direct message" : "Channel");
            return {
                key: `channel:${c.channel_id}`,
                kind: isDm ? "dm" : "channel",
                title,
                subtitle: isDm ? (peerAgent ? "Agent" : "Direct message") : "Channel",
                searchText: isDm ? [title] : [title, c.name],
                frecencyKey: frecencyKey("channel", c.channel_id),
                // Prefer the DM peer's real avatar over the channel's marble SVG.
                avatarUrl: peerHuman?.avatar?.url ?? peerAgent?.avatar?.url ?? c.avatar?.url,
                dmPeerName: peerHuman ? (peerHuman.display_name ?? peerHuman.email) : undefined,
                dmPeerAgentName: peerAgent
                    ? (peerAgent.display_name ?? peerAgent.nickname ?? peerAgent.agent_id)
                    : undefined,
                channelType: c.channel_type,
                onSelect: () => { goToChannel(c.channel_id); },
            };
        });

        // Drop people who already have a DM — selecting them would just
        // create-or-get the very same channel the DM row already opens.
        const people = members
            .filter((m: OrgMember) => m.human_id !== user?.id && !dmPeerHumanIds.has(m.human_id))
            .map<PaletteItem>((m) => ({
                key: `human:${String(m.human_id)}`,
                kind: "person",
                title: m.display_name ?? m.email,
                subtitle: m.email,
                searchText: [m.display_name ?? "", m.email],
                frecencyKey: frecencyKey("human", m.human_id),
                avatarUrl: m.avatar?.url,
                onSelect: () => { openConversation("human", String(m.human_id)); },
            }));

        // Drop agents that already have a DM — same reasoning as people above.
        const agents = agentList
            .filter((a) => !dmPeerAgentIds.has(a.agent_id))
            .map<PaletteItem>((a) => ({
                key: `agent:${a.agent_id}`,
                kind: "agent",
                title: a.display_name ?? a.nickname ?? a.agent_id,
                subtitle: "Agent",
                searchText: [a.display_name ?? "", a.nickname ?? "", a.agent_id],
                frecencyKey: frecencyKey("agent", a.agent_id),
                avatarUrl: a.avatar?.url,
                onSelect: () => { openConversation("agent", a.agent_id); },
            }));

        return [...channelItems, ...people, ...agents];
    }, [channelsQuery.data, membersQuery.data, agentsQuery.data, user?.id, goToChannel, openConversation]);

    const actionItems = useMemo<PaletteItem[]>(
        () => [
            {key: "action:new-dm", kind: "action", title: "New direct message", searchText: ["New direct message", "dm", "message", "chat", "new"], icon: MessageAdd01Icon, tint: "blue", onSelect: () => { runCreate("dm"); }},
            {key: "action:new-channel", kind: "action", title: "New channel", searchText: ["New channel", "channel", "new"], icon: HashtagIcon, tint: "emerald", onSelect: () => { runCreate("channel"); }},
            {key: "action:new-agent", kind: "action", title: "New agent", searchText: ["New agent", "agent", "bot", "clawbot", "add"], icon: Robot02Icon, tint: "violet", onSelect: () => { runCreate("agent"); }},
            {key: "action:invite", kind: "action", title: "Invite people", searchText: ["Invite people", "invite", "members", "add people"], icon: UserAdd01Icon, tint: "rose", onSelect: () => { runAction("/settings/members"); }},
            {key: "action:home", kind: "action", title: "Go to Home", searchText: ["Go to Home", "home"], icon: Home03Icon, tint: "sky", onSelect: () => { runAction("/home"); }},
            {key: "action:skills", kind: "action", title: "Go to Skills", searchText: ["Go to Skills", "skills", "library", "skill"], icon: BookOpen01Icon, tint: "amber", onSelect: () => { runAction("/skills"); }},
            {key: "action:settings", kind: "action", title: "Open settings", searchText: ["Open settings", "settings", "preferences"], icon: Settings01Icon, tint: "slate", onSelect: () => { runAction("/settings"); }},
        ],
        [runAction, runCreate],
    );

    // --- Name-tier grouped result set (instant) -----------------------------
    const groups = useMemo<{kind: ItemKind; items: PaletteItem[]}[]>(() => {
        if (!trimmed) {
            // Empty state: recent conversations (frecency, then activity) + actions.
            const channels = channelsQuery.data?.channels ?? [];
            const byId = new Map(channels.map((c) => [c.channel_id, c] as const));
            const recents = nameItems
                .filter((it) => it.kind === "dm" || it.kind === "channel")
                .map((it) => {
                    const channel = byId.get(it.key.slice("channel:".length));
                    const fr = it.frecencyKey ? frecencyScore(it.frecencyKey, frecency, now) : 0;
                    const activity = channel ? activityTime(channel) : 0;
                    return {it, sort: fr * 1e13 + activity};
                })
                .sort((a, b) => b.sort - a.sort)
                .slice(0, RECENTS_CAP)
                .map((x) => x.it);
            // Headers render as "Recent" / "Actions" regardless of item kind
            // (see the render ternary), so the recents group's kind is only its
            // React key.
            const result: {kind: ItemKind; items: PaletteItem[]}[] = [];
            if (recents.length) result.push({kind: "channel", items: recents});
            result.push({kind: "action", items: actionItems});
            return result;
        }

        // Operators-only (e.g. "from:bob") → the stripped text is empty, so
        // there are no names to match; the Messages block carries the query.
        if (!effectiveText) return [];

        const score = (it: PaletteItem) => {
            const base = fuzzyScoreAny(effectiveText, it.searchText);
            if (base < 0) return -1;
            const fr = it.frecencyKey ? frecencyScore(it.frecencyKey, frecency, now) : 0;
            return base + Math.min(fr, 150);
        };

        const out: {kind: ItemKind; items: PaletteItem[]}[] = [];
        for (const kind of GROUP_ORDER) {
            const pool = kind === "action" ? actionItems : nameItems.filter((it) => it.kind === kind);
            const ranked = pool
                .map((it) => ({it, s: score(it)}))
                .filter((x) => x.s >= 0)
                .sort((a, b) => b.s - a.s)
                .slice(0, PER_GROUP_CAP)
                .map((x) => x.it);
            if (ranked.length) out.push({kind, items: ranked});
        }
        return out;
    }, [trimmed, effectiveText, nameItems, actionItems, channelsQuery.data, frecency, now]);

    // --- Message-tier items (server, async) ---------------------------------
    const messageItems = useMemo<PaletteItem[]>(() => {
        if (!msgActive) return [];
        const data = messagesQuery.data;
        // Only render results matching the current (debounced) text — avoids a
        // flash of the previous query's hits. Filter-only echoes back "".
        if (data?.query.trim() !== msgText) return [];
        return data.results.map<PaletteItem>((r) => ({
            key: `msg:${String(r.post_id)}`,
            kind: "message",
            title: r.snippet,
            searchText: [],
            result: r,
            onSelect: () => { goToMessage(r.channel_id, r.post_id); },
        }));
    }, [messagesQuery.data, msgText, msgActive, goToMessage]);

    // Show the Messages block as soon as the (live) query has searchable text
    // or an active filter; the rows arrive after the debounce.
    const showMessagesBlock =
        trimmed !== "" &&
        (parsed.text.length >= MIN_MESSAGE_QUERY || hasActiveFilters(parsed.filters));
    const messagesLoading =
        showMessagesBlock &&
        messageItems.length === 0 &&
        (debounced !== trimmed ||
            messagesQuery.isFetching ||
            (messagesQuery.data?.query.trim() ?? null) !== msgText);

    // "Show more results" — present when the server reports another page beyond
    // the current cap. Selecting it grows the cap in place (re-fetches a larger
    // set; fine for a palette). Keyboard-navigable, so it joins flatItems.
    const canLoadMore =
        msgActive && messageItems.length > 0 && Boolean(messagesQuery.data?.next_cursor);
    const loadMoreItem = useMemo<PaletteItem | null>(
        () =>
            canLoadMore
                ? {
                      key: "msg:more",
                      kind: "message",
                      title: "Show more results",
                      searchText: [],
                      onSelect: () => { setMessageLimit((n) => Math.min(n + 16, 64)); },
                  }
                : null,
        [canLoadMore],
    );

    // Flatten visible rows for keyboard navigation, in render order
    // (name groups first, then messages, then "show more").
    const flatItems = useMemo<PaletteItem[]>(
        () => [
            ...groups.flatMap((g) => g.items),
            ...messageItems,
            ...(loadMoreItem ? [loadMoreItem] : []),
        ],
        [groups, messageItems, loadMoreItem],
    );

    // Clamp at point-of-use rather than via an effect, so the result set can
    // shrink without a cascading re-render.
    const active = flatItems.length ? Math.min(activeIndex, flatItems.length - 1) : 0;

    useLayoutEffect(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-row-index="${String(active)}"]`);
        el?.scrollIntoView({block: "nearest"});
    }, [active]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        const len = flatItems.length;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex(len ? (active + 1) % len : 0);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex(len ? (active - 1 + len) % len : 0);
        } else if (e.key === "Enter") {
            e.preventDefault();
            flatItems[active]?.onSelect();
        }
    };

    // Remove a filter chip by stripping its operator token from the raw query.
    const removeChip = (token: string) => {
        setQuery((q) => q.replace(token, "").replace(/\s{2,}/g, " ").trim());
    };

    const indexByKey = new Map(flatItems.map((it, i) => [it.key, i] as const));
    const showNoMatches = groups.length === 0 && !showMessagesBlock && trimmed.length > 0;

    // Dismissal guard, shared by both shells: ignore a close fired within a
    // moment of opening — that's the opening tap being caught as an outside-
    // press, not a real close. Genuine Esc / backdrop / Cancel come later.
    const handleOpenChange = (o: boolean) => {
        if (o) return;
        if (Date.now() - openedAtRef.current < 300) return;
        closeCommandPalette();
    };

    // Filter chips (operators) — identical on both platforms.
    const chips =
        parsed.chips.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border/50 px-3.5 py-2">
                {parsed.chips.map((chip) => (
                    <span
                        key={chip.id}
                        className="inline-flex items-center gap-1 rounded-md bg-primary/10 py-0.5 pr-1 pl-2 text-[12px] font-medium text-foreground"
                    >
                        {chip.label}
                        <button
                            type="button"
                            aria-label={`Remove filter ${chip.label}`}
                            onClick={() => { removeChip(chip.token); }}
                            className="flex size-4 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                        >
                            <Icon icon={Cancel01Icon} className="size-3" />
                        </button>
                    </span>
                ))}
            </div>
        ) : null;

    // The scrollable result set (name groups + messages + empty state) — shared
    // verbatim; only the enclosing scroller's sizing differs per platform.
    const results = (
        <>
            {groups.map((group) => (
                        <div key={group.kind} className="pb-1">
                            <p className="px-3 pt-2.5 pb-1.5 text-[12px] font-semibold tracking-wide text-muted-foreground/70">
                                {trimmed
                                    ? GROUP_LABEL[group.kind as Exclude<ItemKind, "message">]
                                    : group.kind === "action"
                                      ? "Actions"
                                      : "Recent"}
                            </p>
                            {group.items.map((item) => {
                                const idx = indexByKey.get(item.key) ?? 0;
                                return (
                                    <Row
                                        key={item.key}
                                        item={item}
                                        index={idx}
                                        active={idx === active}
                                        onHover={setActiveIndex}
                                    />
                                );
                            })}
                        </div>
                    ))}

                    {showMessagesBlock && (
                        <div className="pb-1">
                            <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
                                <p className="text-[12px] font-semibold tracking-wide text-muted-foreground/70">
                                    Messages
                                </p>
                                {messageItems.length > 0 && (
                                    <div className="flex items-center gap-1 rounded-[10px] bg-muted/60 p-1 ring-1 ring-foreground/[0.06]">
                                        {([
                                            {k: "relevant", icon: SparklesIcon, label: "Relevant"},
                                            {k: "recent", icon: Clock01Icon, label: "Recent"},
                                        ] as const).map(({k, icon, label}) => (
                                            <button
                                                key={k}
                                                type="button"
                                                data-active={messageSort === k}
                                                onClick={() => { setMessageSort(k); setMessageLimit(MESSAGE_CAP); }}
                                                className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[active=true]:bg-background data-[active=true]:font-semibold data-[active=true]:text-foreground data-[active=true]:shadow-sm"
                                            >
                                                <Icon icon={icon} className="size-3.5" />
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            {messageItems.length > 0 ? (
                                <>
                                    {messageItems.map((item) => {
                                        if (!item.result) return null;
                                        const idx = indexByKey.get(item.key) ?? 0;
                                        return (
                                            <MessageRow
                                                key={item.key}
                                                result={item.result}
                                                index={idx}
                                                active={idx === active}
                                                onHover={setActiveIndex}
                                                onSelect={item.onSelect}
                                            />
                                        );
                                    })}
                                    {loadMoreItem && (
                                        <button
                                            type="button"
                                            data-row-index={indexByKey.get(loadMoreItem.key) ?? 0}
                                            data-active={(indexByKey.get(loadMoreItem.key) ?? 0) === active}
                                            onClick={loadMoreItem.onSelect}
                                            onMouseMove={() => { setActiveIndex(indexByKey.get(loadMoreItem.key) ?? 0); }}
                                            className="cmdk-row flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left text-[13px] font-medium text-muted-foreground"
                                        >
                                            <span className="cmdk-tile flex size-[30px] shrink-0 items-center justify-center rounded-[9px] text-muted-foreground">
                                                <Icon icon={ArrowDown01Icon} className="size-[17px]" />
                                            </span>
                                            Show more results
                                        </button>
                                    )}
                                </>
                            ) : messagesLoading ? (
                                <p className="px-3 py-2.5 text-[13px] text-muted-foreground/80">Searching messages…</p>
                            ) : (
                                <p className="px-3 py-2.5 text-[13px] text-muted-foreground/80">No message matches.</p>
                            )}
                        </div>
                    )}

            {showNoMatches && (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                    <span className="cmdk-tile flex size-9 items-center justify-center rounded-[10px] text-muted-foreground/70">
                        <Icon icon={Search01Icon} className="size-[18px]" />
                    </span>
                    <p className="text-[13px] text-muted-foreground">No matches found.</p>
                </div>
            )}
        </>
    );

    // --- Mobile: a bottom-sheet drawer ----------------------------------------
    // Matches the app's other mobile sheets (ui/drawer.tsx): rounded top, drag
    // handle, glass, swipe / tap-outside to dismiss. Base UI's Drawer does NOT
    // track the visual viewport, so we size the sheet to --vvh / --vv-offset-top
    // ourselves (the keyboard-safe vars the chat shell publishes via
    // useViewportVars): the Viewport is clamped to the VISIBLE area so
    // ``justify-end`` pins the sheet just above the keyboard rather than behind
    // it, the input stays at the sheet's top, and the results scroll beneath.
    if (isMobile) {
        return (
            <DrawerPrimitive.Root open={open} onOpenChange={handleOpenChange}>
                <DrawerPrimitive.Portal>
                    <DrawerPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/30 transition-opacity duration-200 supports-backdrop-filter:backdrop-blur-sm data-ending-style:opacity-0 data-starting-style:opacity-0" />
                    {/* Standard drawer Viewport (full layout viewport, bottom-anchored)
                        so Base UI's open/drag animation works untouched; the Popup
                        itself is sized to the visual viewport + lifted above the
                        keyboard. */}
                    <DrawerPrimitive.Viewport className="pointer-events-none fixed inset-0 z-50 flex flex-col justify-end">
                        <DrawerPrimitive.Popup
                            data-slot="command-palette-mobile"
                            // height = visible area minus a top gap (the dimmed backdrop
                            // shows through, so it reads as a sheet). marginBottom lifts
                            // the sheet above the on-screen keyboard = layout height −
                            // visible height − top pan; 0 when the keyboard is closed.
                            // Base UI's Drawer doesn't track the visual viewport, so we
                            // do it with the vars useViewportVars publishes.
                            style={{
                                height: "calc(var(--vvh, 100dvh) - 2.5rem)",
                                marginBottom: "calc(100dvh - var(--vvh, 100dvh) - var(--vv-offset-top, 0px))",
                            }}
                            className="pointer-events-auto mx-auto flex w-full max-w-content flex-col overflow-hidden rounded-t-3xl border-t border-sidebar-border bg-popover text-popover-foreground shadow-2xl outline-none supports-backdrop-filter:bg-popover/80 supports-backdrop-filter:backdrop-blur-2xl supports-backdrop-filter:backdrop-saturate-150 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:translate-y-full data-starting-style:translate-y-full"
                        >
                            <DrawerPrimitive.Title className="sr-only">Search</DrawerPrimitive.Title>
                            {/* Drag handle — the sheet's primary touch dismiss affordance. */}
                            <div aria-hidden className="mx-auto mt-2.5 mb-1 h-1.5 w-10 shrink-0 rounded-full bg-foreground/20" />

                            <div className="flex shrink-0 items-center gap-2 px-3 pt-1 pb-2">
                                <div className="relative flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-2xl bg-muted/60 px-3.5 ring-1 ring-foreground/[0.06]">
                                    <Icon icon={Search01Icon} className="size-[18px] shrink-0 text-muted-foreground/70" />
                                    <input
                                        ref={inputRef}
                                        autoFocus
                                        value={query}
                                        onChange={(e) => { setQuery(e.target.value); }}
                                        onKeyDown={onKeyDown}
                                        placeholder="Search messages, people…"
                                        aria-label="Search channels, people, and messages"
                                        className="h-11 w-full min-w-0 bg-transparent text-[16px] text-foreground outline-none placeholder:text-muted-foreground/70"
                                    />
                                    {query && (
                                        <button
                                            type="button"
                                            aria-label="Clear search"
                                            onClick={() => { setQuery(""); inputRef.current?.focus(); }}
                                            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-muted-foreground transition active:scale-90"
                                        >
                                            <Icon icon={Cancel01Icon} className="size-3.5" />
                                        </button>
                                    )}
                                    {messagesLoading && <span className="cmdk-loader" aria-hidden="true" />}
                                </div>
                                <button
                                    type="button"
                                    onClick={() => { closeCommandPalette(); }}
                                    className="shrink-0 rounded-lg px-1.5 py-1 text-[15px] font-medium text-primary transition active:opacity-60"
                                >
                                    Cancel
                                </button>
                            </div>

                            {chips}

                            <div
                                ref={listRef}
                                className="cmdk-scroller min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-[max(0.75rem,var(--safe-bottom))]"
                            >
                                {results}
                            </div>
                        </DrawerPrimitive.Popup>
                    </DrawerPrimitive.Viewport>
                </DrawerPrimitive.Portal>
            </DrawerPrimitive.Root>
        );
    }

    // --- Desktop: the centered command palette (unchanged) ---------------------
    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                showCloseButton={false}
                className="cmdk-panel top-[10vh] w-full max-w-[calc(100%-1.5rem)] translate-y-0 gap-0 overflow-hidden rounded-[18px] p-0 ring-0 shadow-none backdrop-blur-xl sm:max-w-[38rem]"
            >
                <DialogTitle className="sr-only">Command palette</DialogTitle>

                <div className="relative flex items-center gap-3 border-b border-border/50 px-4">
                    <Icon icon={Search01Icon} className="size-[18px] shrink-0 text-muted-foreground/70" />
                    <input
                        ref={inputRef}
                        autoFocus
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); }}
                        onKeyDown={onKeyDown}
                        placeholder="Search channels, people, and messages…"
                        aria-label="Search channels, people, and messages"
                        className="h-[52px] w-full bg-transparent text-[16px] text-foreground outline-none placeholder:text-muted-foreground/70"
                    />
                    {messagesLoading && <span className="cmdk-loader" aria-hidden="true" />}
                </div>

                {chips}

                <div ref={listRef} className="cmdk-scroller max-h-[58vh] overflow-y-auto overscroll-contain px-2 py-2">
                    {results}
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-border/50 px-3.5 py-2.5 text-[11px] text-muted-foreground/80">
                    <span className="flex items-center gap-1.5">
                        <kbd className="cmdk-kbd">↑</kbd>
                        <kbd className="cmdk-kbd">↓</kbd>
                        Navigate
                    </span>
                    <span className="flex items-center gap-3.5">
                        <span className="flex items-center gap-1.5"><kbd className="cmdk-kbd">↵</kbd> Open</span>
                        <span className="flex items-center gap-1.5"><kbd className="cmdk-kbd">esc</kbd> Close</span>
                    </span>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function Row({
    item,
    index,
    active,
    onHover,
}: {
    item: PaletteItem;
    index: number;
    active: boolean;
    onHover: (i: number) => void;
}) {
    return (
        <button
            type="button"
            data-row-index={index}
            data-active={active}
            onClick={item.onSelect}
            onMouseMove={() => { onHover(index); }}
            className="cmdk-row flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left"
        >
            <RowGlyph item={item} />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-foreground">{item.title}</span>
                {item.subtitle && (
                    <span className="block truncate text-[13px] text-muted-foreground">{item.subtitle}</span>
                )}
            </span>
            <span className="cmdk-hint flex shrink-0 items-center gap-1.5 pl-3 text-[12px] font-medium text-muted-foreground">
                {ACTION_VERB[item.kind]}
                <kbd className="cmdk-kbd">↵</kbd>
            </span>
        </button>
    );
}

function MessageRow({
    result,
    index,
    active,
    onHover,
    onSelect,
}: {
    result: MmSearchResult;
    index: number;
    active: boolean;
    onHover: (i: number) => void;
    onSelect: () => void;
}) {
    const author = result.author;
    const authorName = author.display_name ?? (author.kind === "agent" ? "Agent" : "Someone");
    const channelTitle = formatChannelTitle(
        result.channel_display_name,
        result.channel_type === "direct" ? "Direct message" : "Channel",
    );
    return (
        <button
            type="button"
            data-row-index={index}
            data-active={active}
            onClick={onSelect}
            onMouseMove={() => { onHover(index); }}
            className="cmdk-row flex w-full items-start gap-3 rounded-[10px] px-2.5 py-2 text-left"
        >
            {author.kind === "agent" ? (
                <AgentFaceAvatar name={authorName} src={author.avatar?.url} size={30} className="mt-0.5 shrink-0 ring-1 ring-foreground/10" />
            ) : (
                <UserAvatar name={authorName} src={author.avatar?.url} size={30} className="mt-0.5 shrink-0 ring-1 ring-foreground/10" />
            )}
            <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2 text-[13px]">
                    <span className="truncate font-semibold text-foreground">{authorName}</span>
                    <span className="truncate text-muted-foreground/80">in {channelTitle}</span>
                    <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted-foreground/60">
                        {formatRelativeShort(result.created_at)}
                    </span>
                </span>
                <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">
                    <Highlight text={result.snippet} />
                </span>
            </span>
        </button>
    );
}

/**
 * Auth gate. The palette and its Cmd+K binding only exist for signed-in
 * users, so it stays inert on the login/public routes. Mounted once in the
 * app shell.
 */
export function CommandPalette() {
    const {user} = useAuth();
    if (!user) return null;
    return <CommandPaletteInner />;
}

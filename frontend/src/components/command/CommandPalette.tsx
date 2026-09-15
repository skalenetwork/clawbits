import {useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode} from "react";
import {useNavigate} from "react-router-dom";
import {keepPreviousData, useInfiniteQuery, useQuery, useQueryClient} from "@tanstack/react-query";
import {useSelector} from "@tanstack/react-store";
import {Drawer as DrawerPrimitive} from "@base-ui/react/drawer";
import {
    AtSign,
    Bell,
    BookOpen,
    Bot,
    Building2,
    CalendarClock,
    ChartColumn,
    Hash,
    House,
    Link,
    Lock,
    LogIn,
    Megaphone,
    MessageSquarePlus,
    Paintbrush,
    Paperclip,
    Search,
    Settings,
    User,
    UserPlus,
    Users,
    Waves,
    X,
    type LucideIcon,
} from "lucide-react";
import {Dialog, DialogContent, DialogTitle} from "@/components/ui/dialog";
import {DrawerBackdrop} from "@/components/ui/drawer";
import {ChannelGlyph} from "@/components/ChannelGlyph";
import {UserAvatar} from "@/components/UserAvatar";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {useAuth} from "@/context/AuthContext";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {useIsMobile} from "@/hooks/use-mobile";
import {
    createOrGetMmDirect,
    getAgents,
    listMmChannels,
    listOrgMembers,
    searchMessages,
    type MmChannel,
    type MmSearchResult,
    type MmSearchSort,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {fuzzyScoreAny} from "@/lib/fuzzy";
import {frecencyKey, frecencyScore, loadFrecency, recordVisit} from "@/lib/frecency";
import {formatChannelTitle, formatRelativeShort} from "@/lib/formatting";
import {parseSearchQuery, type ParsedQuery} from "@/lib/searchQuery";
import {activityTime} from "@/lib/chatFilters";
import {isDesktop} from "@/lib/desktop";
import {isMac} from "@/lib/shortcuts/platform";
import {useShortcut} from "@/lib/shortcuts";
import {toast} from "@/lib/toast";
import {closeCommandPalette, commandPaletteOpenAtom, toggleCommandPalette} from "./paletteStore";
import {openCreate, type CreateDialogKind} from "./createStore";

type Provider = "chats" | "agents" | "messages" | "actions";
type TabId = "all" | Provider;

interface Item {
    id: string;
    label: string;
    search?: string[];
    lead?: ReactNode;
    meta?: ReactNode;
    keys?: string[];
    activity?: number;
    message?: MmSearchResult;
    run: () => void;
}

interface Section {
    id: string;
    label: string;
    items: Item[];
    status?: string;
}

const TABS: {id: TabId; label: string; caps: Partial<Record<Provider, number>>}[] = [
    {id: "all", label: "All", caps: {chats: 5, agents: 5, actions: 3, messages: 5}},
    {id: "chats", label: "Chats", caps: {chats: Infinity}},
    {id: "agents", label: "Agents", caps: {agents: Infinity}},
    {id: "messages", label: "Messages", caps: {messages: Infinity}},
    {id: "actions", label: "Actions", caps: {actions: Infinity}},
];

const SETTINGS_PAGES: {label: string; path: string; icon: LucideIcon; owner?: boolean}[] = [
    {label: "Profile", path: "/settings/profile", icon: User},
    {label: "Connectors", path: "/settings/connectors", icon: Link},
    {label: "Notifications", path: "/settings/notifications", icon: Bell},
    {label: "Privacy", path: "/settings/privacy", icon: Lock},
    {label: "Appearance", path: "/settings/appearance", icon: Paintbrush},
    {label: "Organization", path: "/settings/organization", icon: Building2, owner: true},
    {label: "Members", path: "/settings/members", icon: Users, owner: true},
    {label: "Usage", path: "/settings/usage", icon: ChartColumn, owner: true},
    {label: "Channels", path: "/settings/channels", icon: Hash, owner: true},
    {label: "LobsterTalk", path: "/settings/lobstertalk", icon: Megaphone, owner: true},
    {label: "Reef", path: "/settings/reef", icon: Waves, owner: true},
];

const OPERATORS: {token: string; hint: string; icon: LucideIcon}[] = [
    {token: "from:", hint: "Person or agent", icon: AtSign},
    {token: "in:", hint: "Chat", icon: Hash},
    {token: "before:", hint: "YYYY-MM-DD", icon: CalendarClock},
    {token: "after:", hint: "YYYY-MM-DD", icon: CalendarClock},
    {token: "has:link", hint: "Messages with links", icon: Link},
    {token: "has:file", hint: "Messages with files", icon: Paperclip},
];

const RECENT_CAP = 6;
const PAGE_SIZE = 25;
const DEBOUNCE_MS = 180;
const EMPTY_QUERY: ParsedQuery = {text: "", filters: {}, chips: []};

const ROW_BASE =
    "flex w-full gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium text-foreground outline-none md:aria-selected:bg-[var(--sb-active)] max-md:active:bg-[var(--sb-active)]";
const LABEL = "text-[13px] font-medium text-muted-foreground";
const PILL =
    "shrink-0 rounded-full font-medium text-muted-foreground hover:text-foreground aria-pressed:bg-[var(--sb-active)] aria-pressed:text-foreground aria-selected:bg-[var(--sb-active)] aria-selected:text-foreground";

const lower = (...texts: string[]) => texts.map((t) => t.toLowerCase());
const mod = (key: string) => (isMac ? `⌘${key}` : `Ctrl ${key}`);
const keepFocus = (e: React.MouseEvent) => {
    e.preventDefault();
};
const glyph = (Icon: LucideIcon) => (
    <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
        <Icon className="size-4"/>
    </span>
);
const chatTime = (c: MmChannel) => formatRelativeShort(c.last_message_at ?? c.created_at);

function Kbd({children}: {children: ReactNode}) {
    return <kbd className="inline-grid h-5 min-w-5 place-items-center rounded-sm border border-border bg-background px-1 font-sans text-[11px] font-medium leading-none text-muted-foreground">{children}</kbd>;
}

function Highlight({text}: {text: string}) {
    // ts_headline wraps hits in literal <mark> without escaping the rest, so it is never rendered as HTML.
    return text.split(/(<mark>.*?<\/mark>)/g).map((part, i) => {
        const hit = /^<mark>(.*)<\/mark>$/s.exec(part);
        return hit ? <mark key={i} className="rounded-[3px] bg-foreground/10 text-foreground">{hit[1]}</mark> : part;
    });
}

function Row({item, id, active, onHover, onSelect}: {
    item: Item;
    id: string;
    active: boolean;
    onHover: () => void;
    onSelect: () => void;
}) {
    const m = item.message;
    const author = m ? (m.author.display_name ?? (m.author.kind === "agent" ? "Agent" : "Someone")) : "";
    return (
        <button
            type="button"
            role="option"
            id={id}
            aria-selected={active}
            tabIndex={-1}
            onMouseDown={keepFocus}
            onMouseMove={onHover}
            onClick={onSelect}
            className={m ? `${ROW_BASE} items-start py-2 leading-5` : `${ROW_BASE} h-[34px] items-center max-md:h-11`}
        >
            {m ? (
                <>
                    {m.author.kind === "agent" ? (
                        <AgentFaceAvatar name={author} src={m.author.avatar?.url} size={20} className="mt-0.5 shrink-0"/>
                    ) : (
                        <UserAvatar name={author} src={m.author.avatar?.url} size={20} className="mt-0.5 shrink-0"/>
                    )}
                    <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-1.5">
                            <span className="truncate">{author}</span>
                            <span className="truncate font-normal text-muted-foreground">
                                in {formatChannelTitle(m.channel_display_name, m.channel_type === "direct" ? "Direct message" : "Channel")}
                            </span>
                            <span className="ml-auto shrink-0 pl-3 text-[12px] font-normal tabular-nums text-muted-foreground">
                                {formatRelativeShort(m.created_at)}
                            </span>
                        </span>
                        <span className="block truncate font-normal text-muted-foreground">
                            <Highlight text={m.snippet}/>
                        </span>
                    </span>
                </>
            ) : (
                <>
                    {item.lead}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.meta && (
                        <span className="flex shrink-0 items-center gap-1 pl-3 text-[12px] font-normal tabular-nums text-muted-foreground">
                            {item.meta}
                        </span>
                    )}
                </>
            )}
        </button>
    );
}

function Palette({mobile}: {mobile: boolean}) {
    const {user, activeOrgId} = useAuth();
    const {isOwner} = useActiveOrg();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const baseId = useId();
    const listId = `${baseId}-list`;
    const listRef = useRef<HTMLDivElement>(null);
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState<TabId>("all");
    const [activeIndex, setActiveIndex] = useState(0);
    const [sort, setSort] = useState<MmSearchSort>("relevant");
    const [frecency] = useState(loadFrecency);
    const [now] = useState(() => Date.now());
    const [debounced, setDebounced] = useState(EMPTY_QUERY);

    const orgId = activeOrgId ?? "";
    const enabled = Boolean(activeOrgId);
    const {data: channelData} = useQuery({
        queryKey: queryKeys.mm.channels(activeOrgId),
        queryFn: () => listMmChannels(activeOrgId),
        enabled,
        staleTime: 60_000,
    });
    const {data: memberData} = useQuery({
        queryKey: queryKeys.orgMembers(orgId),
        queryFn: () => listOrgMembers(orgId),
        enabled,
        staleTime: 60_000,
    });
    const {data: agentData} = useQuery({
        queryKey: queryKeys.agents(orgId),
        queryFn: () => getAgents(orgId),
        enabled,
        staleTime: 60_000,
    });
    const sources = {
        channels: channelData?.channels ?? [],
        members: memberData?.members ?? [],
        agents: agentData?.agents ?? [],
    };
    const parsed = parseSearchQuery(query, sources);
    useEffect(() => {
        const id = setTimeout(() => { setDebounced(parsed); }, DEBOUNCE_MS);
        return () => { clearTimeout(id); };
    }, [parsed]);

    const typing = query.trim() !== "";
    const tab: TabId = picked === "all" && parsed.chips.length > 0 ? "messages" : picked;
    const {caps} = TABS.find((t) => t.id === tab)!;
    const searchable = (p: ParsedQuery) =>
        caps.messages !== undefined &&
        (p.text.length >= (tab === "messages" ? 1 : 2) || Object.keys(p.filters).length > 0);
    const sorting = tab === "messages" && searchable(parsed);
    const messageSort = tab === "messages" ? sort : "relevant";

    const messages = useInfiniteQuery({
        queryKey: queryKeys.mm.search(activeOrgId, debounced.text, messageSort, debounced.filters),
        queryFn: ({pageParam}) =>
            searchMessages({
                orgId: activeOrgId,
                query: debounced.text,
                sort: messageSort,
                cursor: pageParam,
                limit: PAGE_SIZE,
                ...debounced.filters,
            }),
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.next_cursor,
        enabled: enabled && searchable(debounced),
        placeholderData: keepPreviousData,
        staleTime: 30_000,
    });

    const changeQuery = (next: string) => {
        setQuery(next);
        setActiveIndex(0);
    };
    const switchTab = (id: TabId) => {
        setPicked(id);
        setActiveIndex(0);
    };
    const go = (path: string) => () => {
        closeCommandPalette();
        void navigate(path);
    };
    const create = (kind: CreateDialogKind) => () => {
        closeCommandPalette();
        openCreate(kind);
    };
    const openDm = (kind: "human" | "agent", id: string) => () => {
        closeCommandPalette();
        void createOrGetMmDirect(orgId, kind, id).then(
            (channel) => {
                void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
                void navigate(`/channels/${channel.channel_id}`);
            },
            (e: unknown) => {
                toast.error(e instanceof Error ? e.message : "Couldn't open that conversation");
            },
        );
    };
    const keycap = (key: string) => !mobile && <Kbd>{mod(key)}</Kbd>;
    const action = (id: string, label: string, icon: LucideIcon, run: () => void, words = "", meta?: ReactNode): Item => ({
        id: `action:${id}`,
        label,
        search: lower(label, words),
        lead: glyph(icon),
        meta,
        run,
    });

    const agentIds = new Set(sources.agents.map((a) => a.agent_id));
    const dmHumans = new Set(sources.channels.map((c) => c.dm_peer_human_id));
    const agentDms = new Map(sources.channels.map((c) => [c.dm_peer_agent_id, c]));
    const chats: Item[] = [
        ...sources.channels
            .filter((c) => !agentIds.has(c.dm_peer_agent_id ?? ""))
            .map((c): Item => {
                const dm = c.channel_type === "direct";
                const label = formatChannelTitle(c.display_name ?? c.name, dm ? "Direct message" : "Channel");
                return {
                    id: `channel:${c.channel_id}`,
                    label,
                    search: dm ? lower(label) : lower(label, c.name),
                    lead: <ChannelGlyph channel={c} size={20}/>,
                    meta: chatTime(c),
                    keys: [frecencyKey("channel", c.channel_id)],
                    activity: activityTime(c),
                    run: go(`/channels/${c.channel_id}`),
                };
            }),
        ...sources.members
            .filter((m) => m.human_id !== user?.id && !dmHumans.has(m.human_id))
            .map((m): Item => {
                const label = m.display_name ?? m.email;
                return {
                    id: `human:${m.human_id}`,
                    label,
                    search: lower(label, m.email),
                    lead: <UserAvatar name={label} src={m.avatar?.url} size={20}/>,
                    meta: "New chat",
                    keys: [frecencyKey("human", m.human_id)],
                    run: openDm("human", String(m.human_id)),
                };
            }),
    ];
    const agents = sources.agents
        .filter((a) => agentDms.has(a.agent_id) || a.can_dm !== false)
        .map((a): Item => {
            const label = a.display_name ?? a.nickname ?? a.agent_id;
            const dm = agentDms.get(a.agent_id);
            const key = frecencyKey("agent", a.agent_id);
            return {
                id: `agent:${a.agent_id}`,
                label,
                search: lower(label, a.nickname ?? "", a.agent_id),
                lead: <AgentFaceAvatar name={label} src={a.avatar?.url} size={20}/>,
                meta: dm ? chatTime(dm) : "New chat",
                keys: dm ? [key, frecencyKey("channel", dm.channel_id)] : [key],
                activity: dm && activityTime(dm),
                run: dm ? go(`/channels/${dm.channel_id}`) : openDm("agent", a.agent_id),
            };
        });

    const newAgent = action("new-agent", "New agent", Bot, go("/setup/agent"), "bot clawbot add");
    const newChannel = action("new-channel", "New channel", Hash, create("channel"));
    const invite = action("invite", "Invite people", UserPlus, go("/settings/members"), "members add");
    const settings = action("settings", "Settings", Settings, go("/settings"), "preferences", keycap(","));
    const actionGroups: Section[] = [
        {
            id: "create",
            label: "Create",
            items: [
                newAgent,
                newChannel,
                action("new-dm", "New direct message", MessageSquarePlus, create("dm"), "dm message chat"),
                action("join", "Join a channel", LogIn, create("browse"), "browse"),
                invite,
            ],
        },
        {
            id: "go",
            label: "Go to",
            items: [
                action("home", "Home", House, go("/home"), "", isDesktop && keycap("1")),
                action("agents", "Agents", Bot, go("/agents"), "", isDesktop && keycap("2")),
                action("skills", "Skills", BookOpen, go("/skills")),
            ],
        },
        {
            id: "settings",
            label: "Settings",
            items: [
                settings,
                ...SETTINGS_PAGES.filter((p) => isOwner || !p.owner).map((p) =>
                    action(p.path, p.label, p.icon, go(p.path), "settings", "Settings"),
                ),
            ],
        },
    ];

    const found = [...new Map(messages.data?.pages.flatMap((p) => p.results.map((r) => [r.post_id, r] as const))).values()];
    const messageStatus = messages.isError
        ? "Couldn't search messages"
        : messages.isFetchingNextPage
          ? "Loading more…"
          : found.length > 0
            ? undefined
            : messages.isPending || messages.isPlaceholderData || debounced !== parsed
              ? "Searching…"
              : "No messages found";
    const messageSection: Section = {
        id: "messages",
        label: "Messages",
        items: [
            ...found.slice(0, caps.messages).map((r): Item => ({
                id: `message:${r.post_id}`,
                label: r.snippet,
                keys: [frecencyKey("channel", r.channel_id)],
                message: r,
                run: go(`/channels/${r.channel_id}?msg=${r.post_id}`),
            })),
            ...(tab === "all" && found.length > 0
                ? [{
                      id: "all-messages",
                      label: "All message results",
                      lead: glyph(Search),
                      run: () => { switchTab("messages"); },
                  }]
                : []),
        ],
        status: messageStatus,
    };

    const frecencyOf = (it: Item) => Math.max(0, ...(it.keys ?? []).map((k) => frecencyScore(k, frecency, now)));
    const q = parsed.text.toLowerCase();
    const score = (it: Item) => {
        if (!q) return frecencyOf(it) * 1e13 + (it.activity ?? 0);
        const s = fuzzyScoreAny(q, it.search ?? []);
        return s < 0 ? -1 : s + Math.min(frecencyOf(it), 150);
    };
    const rank = (items: Item[], cap = Infinity) =>
        items
            .map((it) => ({it, s: score(it)}))
            .filter((x) => x.s >= 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, cap);
    const pools = {chats, agents, actions: actionGroups.flatMap((g) => g.items)};
    const named = (["chats", "agents", "actions"] as const)
        .filter((p) => caps[p] !== undefined)
        .map((p) => ({p, ranked: rank(pools[p], caps[p])}))
        .sort((a, b) => (b.ranked[0]?.s ?? -1) - (a.ranked[0]?.s ?? -1))
        .map(({p, ranked}): Section => ({
            id: p,
            label: TABS.find((t) => t.id === p)!.label,
            items: ranked.map((x) => x.it),
        }));
    const operatorItems = OPERATORS.map(({token, hint, icon}): Item => ({
        id: `operator:${token}`,
        label: token,
        lead: glyph(icon),
        meta: hint,
        run: () => { changeQuery(`${query.trim()} ${token.endsWith(":") ? token : `${token} `}`.trimStart()); },
    }));
    const sections = (
        !typing && tab === "all"
            ? [
                  {id: "recent", label: "Recent", items: rank([...chats, ...agents], RECENT_CAP).filter((x) => x.s > 0).map((x) => x.it)},
                  {id: "actions", label: "Actions", items: [newAgent, newChannel, invite, settings]},
              ]
            : tab === "messages" && !sorting
              ? [{id: "filters", label: "Filters", items: operatorItems}]
              : !typing && tab === "actions"
                ? actionGroups
                : [...named, ...(searchable(parsed) ? [messageSection] : [])]
    ).filter((s: Section) => s.items.length > 0 || Boolean(s.status));

    const flat = sections.flatMap((s) => s.items);
    const active = Math.min(activeIndex, Math.max(0, flat.length - 1));
    const position = new Map(flat.map((it, i) => [it.id, i]));
    const liveStatus = sections.find((s) => s.status)?.status ?? (typing && !sections.length ? "No matches" : "");

    useLayoutEffect(() => { listRef.current?.scrollTo({top: 0}); }, [query, tab, sort]);

    useLayoutEffect(() => { document.getElementById(`${baseId}-option-${active}`)?.scrollIntoView({block: "nearest"}); }, [baseId, active]);

    const select = (item: Item) => {
        if (item.keys) recordVisit(...item.keys);
        item.run();
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing) return;
        const n = flat.length;
        if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
            e.preventDefault();
            const i = TABS.findIndex((t) => t.id === tab) + (e.code === "BracketRight" ? 1 : TABS.length - 1);
            switchTab(TABS[i % TABS.length]!.id);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex(n ? (active + (e.key === "ArrowDown" ? 1 : n - 1)) % n : 0);
        } else if (e.key === "Enter") {
            e.preventDefault();
            const item = flat[active];
            if (item) select(item);
        }
    };

    const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        if (tab === "messages" && messages.hasNextPage && !messages.isFetching && el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
            void messages.fetchNextPage();
        }
    };

    const input = (
        <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={flat.length ? `${baseId}-option-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Search"
            value={query}
            onChange={(e) => { changeQuery(e.target.value); }}
            onKeyDown={onKeyDown}
            placeholder="Search chats, agents and messages…"
            className={
                mobile
                    ? "h-11 min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-muted-foreground"
                    : "h-12 w-full bg-transparent px-4 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
            }
        />
    );

    return (
        <>
            {mobile ? (
                <div className="flex shrink-0 items-center gap-2 px-3 pt-1 pb-2">
                    <label className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl bg-[var(--sb-hover)] px-3.5">
                        <Search className="size-4 shrink-0 text-muted-foreground"/>
                        {input}
                    </label>
                    <button type="button" onClick={closeCommandPalette} className="shrink-0 px-1.5 text-[15px] font-medium text-primary">
                        Cancel
                    </button>
                </div>
            ) : (
                input
            )}

            {parsed.chips.length > 0 && (
                <div className="flex shrink-0 flex-wrap gap-1.5 px-3 pb-2">
                    {parsed.chips.map((chip, i) => (
                        <span
                            key={i}
                            className={`inline-flex h-6 items-center gap-1 rounded-full pr-1 pl-2.5 text-[12px] font-medium ${
                                chip.unresolved ? "border border-dashed border-border text-muted-foreground" : "bg-[var(--sb-active)] text-foreground"
                            }`}
                        >
                            {chip.unresolved ? `${chip.label} · no match` : chip.label}
                            <button
                                type="button"
                                tabIndex={-1}
                                aria-label={`Remove ${chip.label}`}
                                onMouseDown={keepFocus}
                                onClick={() => { changeQuery(query.replace(chip.token, "").replace(/\s{2,}/g, " ").trim()); }}
                                className="grid size-4 place-items-center rounded-full text-muted-foreground hover:text-foreground"
                            >
                                <X className="size-3"/>
                            </button>
                        </span>
                    ))}
                </div>
            )}

            <div role="tablist" aria-label="Filter" className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto px-3 pb-2">
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={t.id === tab}
                        tabIndex={-1}
                        onMouseDown={keepFocus}
                        onClick={() => { switchTab(t.id); }}
                        className={`${PILL} h-7 px-3 text-[13px] max-md:h-8`}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {sorting && (
                <div className="flex shrink-0 items-center justify-between px-4.5 pt-1 pb-1">
                    <span id={`${baseId}-messages`} className={LABEL}>Messages</span>
                    <span className="flex gap-1">
                        {(["relevant", "recent"] as const).map((s) => (
                            <button
                                key={s}
                                type="button"
                                tabIndex={-1}
                                aria-pressed={sort === s}
                                onMouseDown={keepFocus}
                                onClick={() => {
                                    setSort(s);
                                    setActiveIndex(0);
                                }}
                                className={`${PILL} h-6 px-2.5 text-[12px] capitalize`}
                            >
                                {s}
                            </button>
                        ))}
                    </span>
                </div>
            )}

            <div
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label="Results"
                onScroll={onScroll}
                className={
                    mobile
                        ? "no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[max(0.75rem,var(--safe-bottom))]"
                        : "no-scrollbar max-h-[min(26rem,60vh)] overflow-y-auto overscroll-contain px-2 pb-2"
                }
            >
                {sections.map((s) => (
                    <div key={s.id} role="group" aria-labelledby={`${baseId}-${s.id}`} className="group">
                        {!sorting && (
                            <div role="presentation" id={`${baseId}-${s.id}`} className={`${LABEL} px-2.5 pt-3 pb-1 group-first:pt-1`}>
                                {s.label}
                            </div>
                        )}
                        {s.items.map((item) => {
                            const i = position.get(item.id) ?? 0;
                            return (
                                <Row
                                    key={item.id}
                                    item={item}
                                    id={`${baseId}-option-${i}`}
                                    active={i === active}
                                    onHover={() => { setActiveIndex(i); }}
                                    onSelect={() => { select(item); }}
                                />
                            );
                        })}
                        {s.status && (
                            <p aria-hidden className="flex h-[34px] items-center px-2.5 text-[13px] text-muted-foreground">
                                {s.status}
                            </p>
                        )}
                    </div>
                ))}
                {typing && !sections.length && (
                    <p aria-hidden className="px-4 py-8 text-center text-[13px] text-muted-foreground">No matches</p>
                )}
            </div>

            {!mobile && (
                <div className="flex h-9 items-center gap-4 border-t border-foreground/8 px-3.5 text-[12px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                        <Kbd>↑</Kbd>
                        <Kbd>↓</Kbd>
                        <span className="ml-0.5">Select</span>
                    </span>
                    <span className="flex items-center gap-1">
                        <Kbd>↵</Kbd>
                        <span className="ml-0.5">Open</span>
                    </span>
                    <span className="flex items-center gap-1">
                        <Kbd>{mod("[")}</Kbd>or<Kbd>{mod("]")}</Kbd>
                        <span className="ml-0.5">Change filter</span>
                    </span>
                </div>
            )}

            <p role="status" className="sr-only">{liveStatus}</p>
        </>
    );
}

function PaletteShell() {
    const open = useSelector(commandPaletteOpenAtom);
    const mobile = useIsMobile();
    useShortcut({
        id: "command-palette",
        keys: "$mod+k",
        run: (e) => {
            e.preventDefault();
            toggleCommandPalette();
        },
        hint: {label: "K", group: "Navigation", description: "Search & jump to…"},
        allowInEditable: true,
    });
    const onOpenChange = (next: boolean) => {
        if (!next) closeCommandPalette();
    };

    if (mobile) {
        return (
            <DrawerPrimitive.Root open={open} onOpenChange={onOpenChange}>
                <DrawerPrimitive.Portal>
                    {/* The palette never blurs what it is searching. */}
                    <DrawerBackdrop/>
                    <DrawerPrimitive.Viewport className="pointer-events-none fixed inset-0 z-50 flex flex-col justify-end">
                        <DrawerPrimitive.Popup
                            // Base UI's Drawer ignores the visual viewport: size the sheet to it and lift it above the keyboard.
                            style={{
                                height: "calc(var(--vvh, 100dvh) - 2.5rem)",
                                marginBottom: "calc(100dvh - var(--vvh, 100dvh) - var(--vv-offset-top, 0px))",
                            }}
                            className="pointer-events-auto mx-auto flex w-full max-w-content flex-col overflow-hidden rounded-t-3xl border-t border-border bg-popover text-popover-foreground outline-none transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:translate-y-full data-starting-style:translate-y-full"
                        >
                            <DrawerPrimitive.Title className="sr-only">Search</DrawerPrimitive.Title>
                            <div aria-hidden className="mx-auto mt-2.5 mb-1 h-1.5 w-10 shrink-0 rounded-full bg-foreground/20"/>
                            <Palette mobile/>
                        </DrawerPrimitive.Popup>
                    </DrawerPrimitive.Viewport>
                </DrawerPrimitive.Portal>
            </DrawerPrimitive.Root>
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className="top-[12vh] w-full max-w-[calc(100%-1.5rem)] translate-y-0 gap-0 overflow-hidden rounded-xl border border-border bg-popover p-0 shadow-lg ring-0 backdrop-blur-none backdrop-saturate-100 supports-[backdrop-filter]:bg-popover sm:max-w-[38rem]"
            >
                <DialogTitle className="sr-only">Search</DialogTitle>
                <Palette mobile={false}/>
            </DialogContent>
        </Dialog>
    );
}

export function CommandPalette() {
    const {user} = useAuth();
    return user ? <PaletteShell/> : null;
}

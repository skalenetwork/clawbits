import {NavLink, useLocation, useNavigate} from "react-router-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {Check, ListFilter, Pin, Plus, Search} from "lucide-react";
import {Icon} from "@/components/Icon";
import {useAuth} from "@/context/AuthContext";
import {createMmAgentChat, createOrGetMmDirect, listMmChannels, type MmChannel} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {channelListTitle, formatRelativeShort} from "@/lib/formatting";
import {useChannelActions} from "@/hooks/useChannelActions";
import {ChatContextMenuItems} from "@/components/ChatActionItems";
import {
    CHAT_TABS,
    filterChannelsByTab,
    groupAgentChats,
    sortByRecency,
    useChatTab,
    type AgentChatGroup,
    type ChatTab,
} from "@/lib/chatFilters";
import {errMsg, toast} from "@/lib/toast";
import {ContextMenu, ContextMenuContent, ContextMenuTrigger} from "@/components/ui/context-menu";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {SidebarMenu, SidebarMenuButton, SidebarMenuItem} from "@/components/ui/sidebar";
import {ChannelGlyph} from "@/components/ChannelGlyph";
import {CREATE_OPTIONS, openCreate} from "@/components/command/createStore";
import {openCommandPalette} from "@/components/command/paletteStore";
import {isMac} from "@/lib/shortcuts/platform";
import {SIDEBAR_SCROLL} from "@/components/ProgressiveBlur";
import {SidebarToggle} from "./SidebarToggle";
import {isDesktop} from "@/lib/desktop";
import {NAV_SECTIONS} from "@/lib/navSections";

/** The app's one sidebar: New, the nav and Search, then the Chats list, pinned first, each row ending in one signal. */
export function MainSidebar() {
    const {activeOrgId} = useAuth();
    const {pathname} = useLocation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [tab, setTab] = useChatTab();
    const actions = useChannelActions();

    const channelsQuery = useQuery({
        queryKey: queryKeys.mm.channels(activeOrgId),
        queryFn: () => listMmChannels(activeOrgId),
        enabled: Boolean(activeOrgId),
    });

    const openCreated = (created: MmChannel) => {
        void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
        void navigate(`/channels/${created.channel_id}`);
    };
    const newAgentChat = useMutation({
        mutationFn: (agentId: string) => createMmAgentChat(activeOrgId ?? "", agentId),
        onSuccess: openCreated,
        onError: (e) => { toast.error(errMsg(e, "Couldn't start chat")); },
    });
    const openInbox = useMutation({
        mutationFn: (agentId: string) => createOrGetMmDirect(activeOrgId ?? "", "agent", agentId),
        onSuccess: openCreated,
        onError: (e) => { toast.error(errMsg(e, "Couldn't open chat")); },
    });

    const all = channelsQuery.data?.channels ?? [];
    const recent = sortByRecency(filterChannelsByTab(all, tab));
    const grouped = tab === "agents";
    const list = grouped
        ? recent
        : [...recent.filter((c) => c.pinned), ...recent.filter((c) => !c.pinned)];
    const groups = grouped ? groupAgentChats(recent) : [];
    const open = all.find((c) => pathname === `/channels/${c.channel_id}`) ?? null;
    const inList = grouped
        ? groups.some((g) => g.inbox?.channel_id === open?.channel_id || g.chats.some((c) => c.channel_id === open?.channel_id))
        : list.some((c) => c.channel_id === open?.channel_id);
    const lingering = open && !inList ? open : null;

    return (
        <>
            <div className="px-2 pt-2">
                <SidebarMenu>
                    <SidebarMenuItem className="flex items-center gap-1">
                        <DropdownMenu>
                            <DropdownMenuTrigger render={<SidebarMenuButton className="min-w-0 flex-1"/>}>
                                <Plus/>
                                <span>New</span>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" sideOffset={4} className="min-w-44">
                                {CREATE_OPTIONS.map((option) => (
                                    <DropdownMenuItem
                                        key={option.title}
                                        onClick={() => {
                                            if ("to" in option) void navigate(option.to);
                                            else openCreate(option.kind);
                                        }}
                                    >
                                        <Icon icon={option.icon}/>
                                        {option.title}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        {!isDesktop && <SidebarToggle className="size-[34px] rounded-lg"/>}
                    </SidebarMenuItem>
                    {NAV_SECTIONS.map(({to, label, icon: NavIcon}) => (
                        <SidebarMenuItem key={to}>
                            <SidebarMenuButton render={<NavLink to={to} viewTransition/>} isActive={pathname.startsWith(to)}>
                                <NavIcon/>
                                <span>{label}</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    ))}
                    <SidebarMenuItem>
                        <SidebarMenuButton onClick={() => { openCommandPalette(); }}>
                            <Search/>
                            <span className="flex-1">Search</span>
                            <kbd className="font-sans text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover/menu-button:opacity-100 group-focus-visible/menu-button:opacity-100">{isMac ? "⌘K" : "Ctrl K"}</kbd>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </div>

            <div className={SIDEBAR_SCROLL}>
                <ScopeMenu tab={tab} onChange={setTab}/>
                <SidebarMenu>
                    {lingering && <ChatRow channel={lingering} active actions={actions}/>}
                    {grouped && groups.length > 0 ? (
                        groups.map((g, i) => (
                            <AgentGroup
                                key={g.agentId}
                                group={g}
                                pathname={pathname}
                                actions={actions}
                                spaced={i > 0}
                                creating={newAgentChat.isPending && newAgentChat.variables === g.agentId}
                                onNewChat={() => { newAgentChat.mutate(g.agentId); }}
                                onOpenInbox={g.inbox ? undefined : () => { openInbox.mutate(g.agentId); }}
                            />
                        ))
                    ) : list.length > 0 && !grouped ? (
                        list.map((c) => (
                            <ChatRow
                                key={c.channel_id}
                                channel={c}
                                active={pathname === `/channels/${c.channel_id}`}
                                actions={actions}
                            />
                        ))
                    ) : tab === "dms" ? (
                        <SidebarMenuItem>
                            <SidebarMenuButton onClick={() => { openCreate("dm"); }} className="text-muted-foreground">
                                <Plus/>
                                <span>New DM</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    ) : tab === "agents" ? (
                        <SidebarMenuItem>
                            <SidebarMenuButton onClick={() => { openCreate("chat"); }} className="text-muted-foreground">
                                <Plus/>
                                <span>New agent chat</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    ) : (
                        <li className="list-none px-2 py-4 text-xs text-muted-foreground">
                            {channelsQuery.isLoading
                                ? "Loading…"
                                : tab === "channels"
                                    ? "No channels yet"
                                    : "No conversations yet"}
                        </li>
                    )}
                </SidebarMenu>
            </div>
        </>
    );
}

/** Named, not a funnel: the scope is a view to switch between — the per-agent
 *  one is a different shape of list — and a bare icon never said which was on. */
function ScopeMenu({tab, onChange}: {tab: ChatTab; onChange: (tab: ChatTab) => void}) {
    const current = CHAT_TABS.find((t) => t.id === tab);
    const label = current ? (current.long ?? current.label) : "All chats";
    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                aria-label={`Scope: ${label}`}
                // A row like any other, minus the glyph, with the funnel in the same
                // 20px well a pin sits in. Not a chevron: at the head of a list that
                // reads as "collapse me", which is what this control used to be.
                render={<SidebarMenuButton className="pr-1.5 text-muted-foreground"/>}
            >
                <span className="flex-1 truncate">{label}</span>
                <span className="grid w-5 place-items-center">
                    <ListFilter className="size-3.5"/>
                </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={4} className="min-w-40">
                {CHAT_TABS.map((t) => (
                    <DropdownMenuItem key={t.id} onClick={() => { onChange(t.id); }}>
                        <Icon icon={t.icon} className="size-4"/>
                        <span className="flex-1">{t.long ?? t.label}</span>
                        {t.id === tab && <Check className="size-4 text-muted-foreground"/>}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function agentLabel(group: AgentChatGroup): string {
    const peer = (group.inbox ?? group.chats[0])?.dm_peer;
    return peer?.display_name ?? group.agentId;
}

function AgentGroup({
    group,
    pathname,
    actions,
    spaced,
    creating,
    onNewChat,
    onOpenInbox,
}: {
    group: AgentChatGroup;
    pathname: string;
    actions: ReturnType<typeof useChannelActions>;
    spaced?: boolean;
    creating: boolean;
    onNewChat: () => void;
    onOpenInbox?: () => void;
}) {
    const face = group.inbox ?? group.chats[0];
    if (!face) return null;
    const lead = spaced ? "mt-2" : undefined;
    return (
        <>
            {group.inbox ? (
                <ChatRow
                    channel={group.inbox}
                    active={pathname === `/channels/${group.inbox.channel_id}`}
                    actions={actions}
                    label={agentLabel(group)}
                    className={lead}
                    creating={creating}
                    onNewChat={onNewChat}
                />
            ) : (
                <SidebarMenuItem className={lead}>
                    <SidebarMenuButton onClick={onOpenInbox} className="pr-1.5 group-hover/menu-item:bg-[var(--sb-hover)] group-hover/menu-item:text-sidebar-foreground">
                        <ChannelGlyph channel={face} size={20}/>
                        <span className="min-w-0 flex-1 truncate">{agentLabel(group)}</span>
                        <span className="flex w-9 shrink-0"/>
                    </SidebarMenuButton>
                    <NewChatHoverAction disabled={creating} onClick={onNewChat}/>
                </SidebarMenuItem>
            )}
            {group.chats.map((c) => (
                <ChatRow
                    key={c.channel_id}
                    channel={c}
                    active={pathname === `/channels/${c.channel_id}`}
                    actions={actions}
                    indent
                />
            ))}
        </>
    );
}

function ChatRow({
    channel,
    active,
    actions,
    label,
    indent,
    className,
    creating,
    onNewChat,
}: {
    channel: MmChannel;
    active: boolean;
    actions: ReturnType<typeof useChannelActions>;
    label?: string;
    indent?: boolean;
    className?: string;
    creating?: boolean;
    onNewChat?: () => void;
}) {
    const text = label ?? channelListTitle(channel);
    const signal = signalOf(channel, active, indent);
    const unread = signal.kind === "mention" || signal.kind === "count";
    return (
        <SidebarMenuItem className={className}>
            <ContextMenu>
                <ContextMenuTrigger
                    render={
                        <SidebarMenuButton
                            render={<NavLink to={`/channels/${channel.channel_id}`} viewTransition/>}
                            isActive={active}
                            className={`pr-1.5${onNewChat ? " group-hover/menu-item:bg-[var(--sb-hover)] group-hover/menu-item:text-sidebar-foreground" : ""}${channel.muted ? " opacity-60" : ""}`}
                        >
                            {indent
                                ? <ChatActivity working={Boolean(channel.working)}/>
                                : <ChannelGlyph channel={channel} size={20}/>}
                            <span className={`min-w-0 flex-1 truncate ${unread ? "font-semibold" : ""}`}>{text}</span>
                            <span className={`flex shrink-0 items-center justify-end ${onNewChat ? "group-hover/menu-item:opacity-0 group-has-[button:focus-visible]/menu-item:opacity-0" : ""}`}>
                                <RowSignal signal={signal}/>
                            </span>
                        </SidebarMenuButton>
                    }
                />
                <ContextMenuContent>
                    <ChatContextMenuItems channel={channel} actions={actions}/>
                </ContextMenuContent>
            </ContextMenu>
            {onNewChat && <NewChatHoverAction disabled={creating} onClick={onNewChat}/>}
        </SidebarMenuItem>
    );
}

function NewChatHoverAction({disabled, onClick}: {disabled?: boolean; onClick: () => void}) {
    return (
        <button
            type="button"
            disabled={disabled}
            aria-label="New chat"
            title="New chat"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onClick();
            }}
            className="absolute inset-y-0 right-1.5 z-10 flex w-9 items-center justify-end opacity-0 pointer-events-none transition-opacity group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
        >
            <Plus className="size-3.5 text-muted-foreground"/>
        </button>
    );
}

/** Loudest first: a mention pierces mute, then unread, an agent mid-reply, the pin, the time. */
type Signal =
    | {kind: "mention"; n: number}
    | {kind: "count"; n: number}
    | {kind: "working"}
    | {kind: "pinned"}
    | {kind: "time"; at: string};

function signalOf(channel: MmChannel, active: boolean, activityLead = false): Signal {
    const mentions = channel.unread_mention_count ?? 0;
    const unread = channel.unread_count ?? 0;
    if (!active && mentions > 0) return {kind: "mention", n: mentions};
    if (!active && unread > 0 && !channel.muted) return {kind: "count", n: unread};
    if (channel.working && !activityLead) return {kind: "working"};
    if (channel.pinned) return {kind: "pinned"};
    return {kind: "time", at: channel.last_message_at ?? channel.created_at};
}

function WorkingDot() {
    return (
        <span
            className="working-dot size-1.5 rounded-full bg-signal"
            role="status"
            aria-label="Replying"
        />
    );
}

function ChatActivity({working}: {working: boolean}) {
    return (
        <span className="grid size-5 shrink-0 place-items-center">
            {working ? <WorkingDot/> : <span className="size-1.5 rounded-full bg-muted-foreground/40" aria-hidden/>}
        </span>
    );
}

function RowSignal({signal}: {signal: Signal}) {
    switch (signal.kind) {
        case "mention":
        case "count": {
            const mention = signal.kind === "mention";
            return (
                <span
                    className="grid h-[19px] min-w-[19px] place-items-center rounded-full bg-unread px-1.5 text-[10px] font-semibold leading-none tabular-nums text-white"
                    aria-label={`${String(signal.n)} ${mention ? "mention" : "unread message"}${signal.n === 1 ? "" : "s"}`}
                >
                    {mention && "@"}
                    {signal.n > 99 ? "99+" : signal.n}
                </span>
            );
        }
        case "working":
            return (
                <span className="grid w-5 place-items-center">
                    <WorkingDot/>
                </span>
            );
        case "pinned":
            return (
                <span role="img" aria-label="Pinned" className="grid w-5 place-items-center text-muted-foreground">
                    <Pin className="size-3.5"/>
                </span>
            );
        case "time":
            return (
                <span className="text-[10px] font-normal tabular-nums text-muted-foreground">
                    {formatRelativeShort(signal.at)}
                </span>
            );
    }
}

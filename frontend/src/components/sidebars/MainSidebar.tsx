import {NavLink, useLocation, useNavigate} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {Check, ListFilter, Pin, Plus, Search} from "lucide-react";
import {Icon} from "@/components/Icon";
import {useAuth} from "@/context/AuthContext";
import {listMmChannels, type MmChannel} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {formatChannelTitle, formatRelativeShort} from "@/lib/formatting";
import {useChannelActions} from "@/hooks/useChannelActions";
import {ChatContextMenuItems} from "@/components/ChatActionItems";
import {
    CHAT_TABS,
    filterChannelsByTab,
    sortByRecency,
    useChatTab,
    type ChatTab,
} from "@/lib/chatFilters";
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
import {CollapsibleGroup} from "./CollapsibleGroup";
import {SIDEBAR_SCROLL} from "@/components/ProgressiveBlur";
import {SidebarToggle} from "./SidebarToggle";
import {isDesktop} from "@/lib/desktop";
import {NAV_SECTIONS} from "@/lib/navSections";

/** The app's one sidebar: New, the nav and Search, then the Chats list, pinned first, each row ending in one signal. */
export function MainSidebar() {
    const {activeOrgId} = useAuth();
    const {pathname} = useLocation();
    const navigate = useNavigate();
    const [tab, setTab] = useChatTab();
    const actions = useChannelActions();

    const channelsQuery = useQuery({
        queryKey: queryKeys.mm.channels(activeOrgId),
        queryFn: () => listMmChannels(activeOrgId),
        enabled: Boolean(activeOrgId),
    });

    const all = channelsQuery.data?.channels ?? [];
    const recent = sortByRecency(filterChannelsByTab(all, tab));
    const list = [...recent.filter((c) => c.pinned), ...recent.filter((c) => !c.pinned)];
    const open = all.find((c) => pathname === `/channels/${c.channel_id}`) ?? null;
    const lingering = open && !list.some((c) => c.channel_id === open.channel_id) ? open : null;

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
                <CollapsibleGroup id="chats" label="Chats" action={<ScopeMenu tab={tab} onChange={setTab}/>}>
                    {lingering && <ChatRow channel={lingering} active actions={actions}/>}
                    {list.length > 0 ? (
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
                    ) : (
                        <li className="list-none px-2 py-4 text-xs text-muted-foreground">
                            {channelsQuery.isLoading
                                ? "Loading…"
                                : tab === "channels"
                                    ? "No channels yet"
                                    : "No conversations yet"}
                        </li>
                    )}
                </CollapsibleGroup>
            </div>
        </>
    );
}

function ScopeMenu({tab, onChange}: {tab: ChatTab; onChange: (tab: ChatTab) => void}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                title="Filter chats"
                aria-label="Filter chats"
                className={`grid size-5 place-items-center rounded-md outline-hidden transition-colors hover:bg-[var(--sb-hover)] ${tab === "all" ? "text-muted-foreground hover:text-sidebar-foreground" : "text-signal"}`}
            >
                <ListFilter className="size-3"/>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
                {CHAT_TABS.map((t) => (
                    <DropdownMenuItem key={t.id} onClick={() => { onChange(t.id); }}>
                        <Icon icon={t.icon} className="size-4"/>
                        <span className="flex-1">{t.label}</span>
                        {t.id === tab && <Check className="size-4 text-muted-foreground"/>}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function ChatRow({
    channel,
    active,
    actions,
}: {
    channel: MmChannel;
    active: boolean;
    actions: ReturnType<typeof useChannelActions>;
}) {
    const label = formatChannelTitle(channel.display_name ?? channel.name);
    const signal = signalOf(channel, active);
    const unread = signal.kind === "mention" || signal.kind === "count";
    return (
        <SidebarMenuItem>
            <ContextMenu>
                <ContextMenuTrigger
                    render={
                        <SidebarMenuButton
                            render={<NavLink to={`/channels/${channel.channel_id}`} viewTransition/>}
                            isActive={active}
                            className={channel.muted ? "opacity-60" : undefined}
                        >
                            <ChannelGlyph channel={channel} size={20}/>
                            <span className={`min-w-0 flex-1 truncate ${unread ? "font-semibold" : ""}`}>{label}</span>
                            <span className="flex w-9 shrink-0 items-center justify-end">
                                <RowSignal signal={signal}/>
                            </span>
                        </SidebarMenuButton>
                    }
                />
                <ContextMenuContent>
                    <ChatContextMenuItems channel={channel} actions={actions}/>
                </ContextMenuContent>
            </ContextMenu>
        </SidebarMenuItem>
    );
}

/** Loudest first: a mention pierces mute, then unread, an agent mid-reply, the pin, the time. */
type Signal =
    | {kind: "mention"; n: number}
    | {kind: "count"; n: number}
    | {kind: "working"}
    | {kind: "pinned"}
    | {kind: "time"; at: string};

function signalOf(channel: MmChannel, active: boolean): Signal {
    const mentions = channel.unread_mention_count ?? 0;
    const unread = channel.unread_count ?? 0;
    if (!active && mentions > 0) return {kind: "mention", n: mentions};
    if (!active && unread > 0 && !channel.muted) return {kind: "count", n: unread};
    if (channel.working) return {kind: "working"};
    if (channel.pinned) return {kind: "pinned"};
    return {kind: "time", at: channel.last_message_at ?? channel.created_at};
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
                <span role="img" aria-label="Replying" className="grid w-5 place-items-center">
                    <span className="size-[10px] animate-spin rounded-full border-[1.5px] border-signal border-r-transparent motion-reduce:animate-none"/>
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

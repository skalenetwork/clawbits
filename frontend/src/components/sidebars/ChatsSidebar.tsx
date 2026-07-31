import {NavLink, useLocation} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {
    Add01Icon as Plus,
    MessageAdd01Icon as NewChat,
    Attachment01Icon as Paperclip,
    Search01Icon as Search,
    HashtagIcon as Hash,
    Message01Icon as MessageIcon,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {useAuth} from "@/context/AuthContext";
import {
    listMmChannels,
    listDiscoverableMmChannels,
    type MmChannel,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {formatChannelTitle, formatRelativeShort} from "@/lib/formatting";
import {useMessageDrafts} from "@/hooks/useMessageDrafts";
import {useChannelActions} from "@/hooks/useChannelActions";
import {ChatTabs} from "@/components/ChatTabs";
import {ChatContextMenuItems} from "@/components/ChatActionItems";
import {
    filterChannelsByTab,
    sortByRecency,
    useChatTab,
} from "@/lib/chatFilters";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {SidebarMenu, SidebarMenuButton, SidebarMenuItem} from "@/components/ui/sidebar";
import {ChannelGlyph} from "@/components/ChannelGlyph";
import {openCreate} from "@/components/command/createStore";
import {ContextualHeader} from "./ContextualHeader";

/**
 * The Chats contextual sidebar: a header, an All / Channels / DMs scope
 * filter, and a single recency-sorted conversation list filtered by the
 * active scope. Pins live on the rail's permanent pins cluster (see
 * ``RailChats``); a pinned chat sits in this list at its natural position.
 *
 * Unread language (shared with the rail): a mention is the only signal that
 * shouts — a red ``@N`` pill that pierces mute. DM unreads get a red count
 * (personal, worth counting); channel unreads get a plain ink dot (ambient
 * chatter, not homework). Muted chats show nothing and render dimmed.
 *
 * When the open conversation falls outside the active scope (a DM open while
 * the Channels scope is on), it stays visible as a **linger slot** — a single
 * highlighted row above the filtered list, separated by a hairline — so "where
 * am I" never breaks. Same doctrine as the rail's lingering active chat.
 *
 * Owns its own queries and create/join/DM dialogs so the shell stays thin; the
 * channels query shares its cache key with the rail + unread badge, so there's
 * no double fetch. Per-row actions come from the shared ``useChannelActions``.
 */
export function ChatsSidebar() {
    const {user, activeOrgId} = useAuth();
    const location = useLocation();
    const pathname = location.pathname;

    const [tab, setTab] = useChatTab();

    // Unsent per-channel drafts (local to this device). A chat with a draft
    // shows a "Draft:" preview in place of its last message — the
    // Telegram/WhatsApp convention — updating live as the user types.
    const drafts = useMessageDrafts(user?.id);
    const actions = useChannelActions();

    const channelsQuery = useQuery({
        queryKey: queryKeys.mm.channels(activeOrgId ?? null),
        queryFn: () => listMmChannels(activeOrgId ?? null),
        enabled: Boolean(activeOrgId),
    });

    // Gate the "Join channel" menu item — cheap row-count per public channel.
    const discoverableQuery = useQuery({
        queryKey: activeOrgId ? ["mm", "discoverable", activeOrgId] : ["mm", "discoverable", "none"],
        queryFn: () => listDiscoverableMmChannels(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId),
        staleTime: 30_000,
    });
    const hasDiscoverable = (discoverableQuery.data?.total ?? 0) > 0;

    const all = channelsQuery.data?.channels ?? [];
    const list = sortByRecency(filterChannelsByTab(all, tab));

    // Linger slot: the currently open conversation, when the active scope
    // filters it out. Rendered above the list so switching to Channels while
    // a DM is open never orphans the thing you're looking at.
    const activeChannel = all.find((c) => pathname === `/channels/${c.channel_id}`) ?? null;
    const lingering =
        activeChannel && !list.some((c) => c.channel_id === activeChannel.channel_id)
            ? activeChannel
            : null;

    const renderRow = (channel: MmChannel) => {
        const channelPath = `/channels/${channel.channel_id}`;
        const label = formatChannelTitle(channel.display_name ?? channel.name);
        const unread = channel.unread_count ?? 0;
        const mentionCount = channel.unread_mention_count ?? 0;
        const muted = Boolean(channel.muted);
        const isActive = pathname === channelPath;
        const hasUnread = unread > 0 && !isActive;
        // A mention is a subset of unread, but it pierces mute and gets the
        // red accent "@N" pill — the one signal allowed to shout.
        const hasMention = mentionCount > 0 && !isActive;
        const isDm = channel.channel_type === "direct";
        // Muted means muted: no count, no dot, regular-weight name, dimmed
        // row — only a mention breaks through.
        const showsCount = hasUnread && !muted && isDm;
        const showsDot = hasUnread && !muted && !isDm;
        const showsBold = hasMention || (hasUnread && !muted);
        const preview = channel.last_message_text ?? null;
        const attachmentCount = channel.last_message_attachment_count ?? 0;
        const hasAttachment = attachmentCount > 0;
        const authorName = channel.last_message_author_display_name ?? null;
        // Channel previews carry a "name:" author prefix (first name only —
        // the 10px author avatars read as stray emoji at preview size). DMs
        // skip it; the peer is implied and own messages keep "You:".
        const authorFirstName = authorName?.trim().split(/\s+/)[0] ?? null;
        const isOwnLastMessage = user?.id != null && channel.last_message_author_human_id === user.id;
        const dmPrefix = isDm && isOwnLastMessage ? "You: " : "";
        // Unsent draft wins over the last-message preview (Telegram pattern).
        // Newlines collapse so a multi-line draft stays a one-line preview.
        const draftText = drafts.get(channel.channel_id)?.text.trim() ?? "";
        const draftPreview =
            draftText.length > 0 ? draftText.replace(/\s+/g, " ") : null;
        return (
            <SidebarMenuItem key={channel.channel_id}>
                <ContextMenu>
                    <ContextMenuTrigger
                        render={
                            <SidebarMenuButton
                                size="lg"
                                render={<NavLink to={channelPath} viewTransition/>}
                                isActive={isActive}
                                tooltip={label}
                                className="h-12 items-center gap-2.5 rounded-lg px-2.5 text-[13px]"
                            >
                                <ChannelGlyph channel={channel} size={26} className={muted ? "opacity-60" : undefined}/>
                                <div className={`flex min-w-0 flex-1 flex-col justify-center gap-0.5 leading-tight ${muted ? "opacity-60" : ""}`}>
                                    <span className={`min-w-0 truncate ${showsBold ? "font-semibold" : ""}`}>
                                        {label}
                                    </span>
                                    <div className="flex min-w-0 items-center gap-1 text-[11px] font-normal text-muted-foreground">
                                        {draftPreview ? (
                                            <span className="min-w-0 flex-1 truncate">
                                                <span className="font-medium text-destructive">Draft:</span>{" "}
                                                {draftPreview}
                                            </span>
                                        ) : preview || hasAttachment ? (
                                            <>
                                                {!isDm && authorFirstName && (
                                                    <span className="shrink-0 font-medium">
                                                        {isOwnLastMessage ? "You:" : `${authorFirstName}:`}
                                                    </span>
                                                )}
                                                {hasAttachment && (
                                                    <Icon icon={Paperclip} className="size-2.5! shrink-0 opacity-70"/>
                                                )}
                                                <span className="min-w-0 flex-1 truncate">
                                                    {preview
                                                        ? `${dmPrefix}${preview}`
                                                        : dmPrefix + (attachmentCount === 1 ? "Attachment" : `${String(attachmentCount)} attachments`)}
                                                </span>
                                            </>
                                        ) : (
                                            <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
                                                No messages
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className={`flex shrink-0 flex-col items-end self-stretch py-1 text-[10px] leading-none ${hasMention || showsCount || showsDot ? "justify-between" : "justify-center"}`}>
                                    <span className="font-normal text-muted-foreground tabular-nums">
                                        {formatRelativeShort(channel.last_message_at ?? channel.created_at)}
                                    </span>
                                    {hasMention ? (
                                        <span
                                            className="rounded-full bg-unread px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none text-white shadow-sm"
                                            aria-label={`${String(mentionCount)} mention${mentionCount === 1 ? "" : "s"}`}
                                        >
                                            @{mentionCount > 99 ? "99+" : mentionCount}
                                        </span>
                                    ) : showsCount ? (
                                        <span
                                            className="rounded-full bg-unread px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none text-white shadow-sm"
                                            aria-label={`${String(unread)} unread message${unread === 1 ? "" : "s"}`}
                                        >
                                            {unread > 99 ? "99+" : unread}
                                        </span>
                                    ) : showsDot ? (
                                        <span
                                            role="img"
                                            aria-label={`${String(unread)} unread message${unread === 1 ? "" : "s"}`}
                                            className="mb-0.5 size-[7px] rounded-full bg-sidebar-foreground/75"
                                        />
                                    ) : null}
                                </div>
                            </SidebarMenuButton>
                        }
                    />
                    <ContextMenuContent>
                        <ChatContextMenuItems channel={channel} actions={actions}/>
                    </ContextMenuContent>
                </ContextMenu>
            </SidebarMenuItem>
        );
    };

    // Unified compose action for the section header — covers channel + DM
    // creation (and joining a public channel), so the per-group "+" buttons
    // are no longer needed. Search lives in ⌘K (and the Home search box), so
    // it is no longer duplicated here. Each item drives the shared create
    // dialogs mounted once in the app shell (see CreateDialogs). Ghost style:
    // a solid primary block up here outshouted every actual unread signal.
    const headerAction = (
        <DropdownMenu>
            <DropdownMenuTrigger
                title="New conversation"
                aria-label="New conversation"
                className="relative flex size-6 items-center justify-center rounded-md border border-sidebar-border text-muted-foreground outline-hidden transition duration-100 after:absolute after:-inset-2 hover:bg-[var(--sb-hover)] hover:text-foreground active:scale-90 data-[pressed]:scale-90"
            >
                <Icon icon={NewChat} className="size-4"/>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4}>
                <DropdownMenuItem onClick={() => { openCreate("channel"); }}>
                    <Icon icon={Hash} className="size-4"/> New channel
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { openCreate("dm"); }}>
                    <Icon icon={MessageIcon} className="size-4"/> New direct message
                </DropdownMenuItem>
                {hasDiscoverable && (
                    <DropdownMenuItem onClick={() => { openCreate("browse"); }}>
                        <Icon icon={Search} className="size-4"/> Join channel
                    </DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );

    return (
        <>
            <ContextualHeader title="Chats" action={headerAction}/>
            {/* Scope tabs — ChatTabs renders its own translucent ``popover``
                pill (the bottom-nav look); this positions it below the header,
                edge-aligned with the list's 8px insets. */}
            <div className="absolute inset-x-0 top-12 z-10 px-2 pt-2">
                <ChatTabs value={tab} onValueChange={setTab}/>
            </div>
            {/* Scroll region clears the header (3rem) + the tabs section. */}
            <div data-vt-contextual="" className="no-scrollbar flex-1 overflow-y-auto px-2 pb-2 pt-[6rem]">
                <SidebarMenu>
                    {lingering && (
                        <>
                            {renderRow(lingering)}
                            <li
                                role="separator"
                                aria-orientation="horizontal"
                                className="mx-1 mb-1 mt-0.5 h-px list-none bg-sidebar-border/70"
                            />
                        </>
                    )}
                    {list.length > 0 ? (
                        list.map(renderRow)
                    ) : tab === "dms" ? (
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                onClick={() => { openCreate("dm"); }}
                                tooltip="New DM"
                                className="text-muted-foreground"
                            >
                                <Icon icon={Plus}/>
                                <span>New DM</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    ) : (
                        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                            {channelsQuery.isLoading
                                ? "Loading…"
                                : tab === "channels"
                                    ? "No channels yet"
                                    : "No conversations yet"}
                        </p>
                    )}
                </SidebarMenu>
            </div>
        </>
    );
}

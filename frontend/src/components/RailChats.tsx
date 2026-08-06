import {useState} from "react";
import {useLocation, useNavigate} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {useAuth} from "@/context/AuthContext";
import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {ChannelGlyph} from "@/components/ChannelGlyph";
import {ChatContextMenuItems} from "@/components/ChatActionItems";
import {railSlotHintId, RAIL_CHAT_SLOT_OFFSET, MAX_RAIL_SLOTS} from "@/lib/railSlots";
import {useChannelActions, type ChannelActions} from "@/hooks/useChannelActions";
import {listMmChannels, type MmChannel} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {formatChannelTitle} from "@/lib/formatting";
import {cn} from "@/lib/utils";

/**
 * A single chat on the rail: the channel/DM avatar with a corner unread counter,
 * a right-side name tooltip (matching the rail's nav buttons), and a right-click
 * context menu carrying the same actions as the chat-list rows. Clicking jumps
 * to the channel.
 *
 * Tooltip + context menu compose by nesting their triggers onto one button:
 * the ContextMenu is the outer root, the Tooltip wraps the trigger, and the
 * ContextMenuTrigger is the innermost render target — so hover shows the name
 * and right-click opens the menu, both on the same element.
 *
 * The presence dot is suppressed (``showPresenceDot={false}``): the rail's only
 * corner overlay is the unread indicator, following the ladder shared with the
 * chat-list rows — red ``@N`` for mentions, red count for DM unreads, a plain
 * ink dot for channel chatter, nothing when muted (mentions pierce). The
 * indicator hides once a chat is read (``unread === 0``): pinned avatars then
 * linger without a badge, carrying the rail's active highlight instead.
 */
export function RailChatButton({
    channel,
    active,
    onClick,
    actions,
    hintId,
}: {
    channel: MmChannel;
    active: boolean;
    onClick: () => void;
    actions: ChannelActions;
    /** Shortcut-hint anchor id (``data-shortcut-hint``) for pinned chats that
     *  hold a ⌘-number slot, so the hold-⌘ overlay badges them. Unset for
     *  unread (unnumbered) chats. See RailNavShortcuts. */
    hintId?: string;
}) {
    const label = formatChannelTitle(channel.display_name ?? channel.name);
    const unread = channel.unread_count ?? 0;
    const mentionCount = channel.unread_mention_count ?? 0;
    const hasMention = mentionCount > 0;
    const muted = Boolean(channel.muted);
    const isDm = channel.channel_type === "direct";
    const showsCount = unread > 0 && !muted && isDm;
    const showsDot = unread > 0 && !muted && !isDm;
    return (
        <ContextMenu>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <ContextMenuTrigger
                            render={
                                <button
                                    type="button"
                                    onClick={onClick}
                                    data-shortcut-hint={hintId}
                                    aria-label={
                                        hasMention
                                            ? `${label}, ${String(mentionCount)} mention${mentionCount === 1 ? "" : "s"}`
                                            : unread > 0
                                                ? `${label}, ${String(unread)} unread message${unread === 1 ? "" : "s"}`
                                                : label
                                    }
                                    aria-current={active ? "page" : undefined}
                                    className={cn(
                                        "flex size-9 shrink-0 items-center justify-center rounded-lg transition duration-100 active:scale-90",
                                        active ? "bg-sidebar-foreground/10" : "hover:bg-sidebar-foreground/5",
                                    )}
                                >
                                    {/* Avatar sized to match the org-switcher mark (26px);
                                        the size-9 button leaves a small padding ring around
                                        it for an easier click target + hover highlight. */}
                                    <span className="relative flex">
                                        <ChannelGlyph channel={channel} size={26} showPresenceDot={false}/>
                                        {hasMention ? (
                                            <span
                                                className="absolute -right-1 -top-1 min-w-4 rounded-full bg-unread px-1 py-0.5 text-center text-[10px] font-semibold leading-none tabular-nums text-white shadow-sm ring-2 ring-background"
                                            >
                                                @{mentionCount > 99 ? "99+" : mentionCount}
                                            </span>
                                        ) : showsCount ? (
                                            <span
                                                className="absolute -right-1 -top-1 min-w-4 rounded-full bg-unread px-1 py-0.5 text-center text-[10px] font-semibold leading-none tabular-nums text-white shadow-sm ring-2 ring-background"
                                            >
                                                {unread > 99 ? "99+" : unread}
                                            </span>
                                        ) : showsDot ? (
                                            <span
                                                role="img"
                                                aria-label={`${String(unread)} unread message${unread === 1 ? "" : "s"}`}
                                                className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-sidebar-foreground/80 ring-2 ring-background"
                                            />
                                        ) : null}
                                    </span>
                                </button>
                            }
                        />
                    }
                />
                <TooltipContent side="right" sideOffset={8} className="text-xs">
                    {label}
                </TooltipContent>
            </Tooltip>
            <ContextMenuContent>
                <ChatContextMenuItems channel={channel} actions={actions}/>
            </ContextMenuContent>
        </ContextMenu>
    );
}

/**
 * Chats cluster on the app rail, directly below the Agents button: a permanent
 * **Pins** section on top, then a transient **Unread** section beneath it.
 *
 * - *Pins* surfaces every channel/DM the user has pinned — always present (the
 *   rail counterpart to the old sidebar "Pins" group), one small avatar each,
 *   with an unread counter when there's something new and a right-click menu.
 * - *Unread* surfaces every *non-pinned, non-muted* chat with unread messages
 *   (pinned ones already live in the Pins section above, so nothing appears
 *   twice; muted chats only surface when a mention pierces), plus the
 *   Discord-style lingering active chat.
 *
 * Lingering: opening a chat marks it read (count → 0) but its avatar stays —
 * shown active, sans badge — until the user navigates away, rather than
 * vanishing the instant it's opened. We snapshot whether the entered channel
 * was unread *before* ChannelPage's auto-mark-read pass zeroes it (adjusting
 * state during render, React's recommended alternative to an effect), so
 * opening an already-read chat from the list doesn't pull it onto the rail.
 *
 * Self-contained: subscribes to the same ``listMmChannels`` cache key the shell
 * already populates (React Query dedupes — no extra fetch), staying live as
 * ``useGlobalEvents`` patches unread/pin state over SSE. Renders nothing when
 * there are no pins and nothing unread.
 */
export function RailChats() {
    const {activeOrgId} = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const actions = useChannelActions();

    const channelsQuery = useQuery({
        queryKey: queryKeys.mm.channels(activeOrgId ?? null),
        queryFn: () => listMmChannels(activeOrgId ?? null),
        enabled: Boolean(activeOrgId),
    });

    const all = channelsQuery.data?.channels ?? [];
    const activeChannelId = /^\/channels\/([^/]+)/.exec(location.pathname)?.[1] ?? null;

    const [linger, setLinger] = useState<{active: string | null; id: string | null}>({
        active: null,
        id: null,
    });
    if (linger.active !== activeChannelId) {
        const entered = activeChannelId == null
            ? undefined
            : all.find((c) => c.channel_id === activeChannelId);
        setLinger({
            active: activeChannelId,
            id: (entered?.unread_count ?? 0) > 0 ? activeChannelId : null,
        });
    }

    // Pinned chats are permanent; the unread section is non-pinned chats that
    // are unread-and-not-muted (mentions pierce mute), or the lingering active
    // one — so a pinned-and-unread chat shows only once, in Pins, and muted
    // chatter stays off the rail. Both keep the natural newest-first order.
    const pinned = all.filter((c) => c.pinned);
    const unread = all.filter(
        (c) =>
            !c.pinned
            && (((c.unread_count ?? 0) > 0 && !c.muted)
                || (c.unread_mention_count ?? 0) > 0
                || c.channel_id === linger.id),
    );

    if (pinned.length === 0 && unread.length === 0) return null;

    const renderButton = (channel: MmChannel, hintId?: string) => (
        <RailChatButton
            key={channel.channel_id}
            channel={channel}
            active={channel.channel_id === activeChannelId}
            onClick={() => { void navigate(`/channels/${channel.channel_id}`); }}
            actions={actions}
            hintId={hintId}
        />
    );

    // Pinned chats take rail slots after the fixed nav sections — pinned[j] is
    // ⌘(RAIL_CHAT_SLOT_OFFSET + 1 + j), capped at ⌘9. Only those get a hint
    // badge; the order matches RailNavShortcuts (same channels cache, same
    // pinned filter). Unread chats stay unnumbered.
    const pinnedHintId = (j: number): string | undefined => {
        const slot = RAIL_CHAT_SLOT_OFFSET + 1 + j;
        return slot <= MAX_RAIL_SLOTS ? railSlotHintId(slot) : undefined;
    };

    return (
        <div className="flex min-h-0 w-full flex-1 flex-col items-center">
            {/* Inset top divider — side margins keep it clear of the rail edges.
                Pinned above the scroll region (not a border on it) so it can be
                narrower than the rail without the scroll box clipping the
                avatars' corner badges. */}
            <div className="my-1 h-px w-7 shrink-0 bg-sidebar-border"/>
            {/* Scroll region: a long list scrolls internally instead of pushing
                the bottom-pinned Appearance/Settings cluster off-screen. Stays
                w-full so the corner badges aren't clipped; scrollbar hidden - an
                8px bar would crowd the rail's buttons. */}
            <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {pinned.map((channel, j) => renderButton(channel, pinnedHintId(j)))}
                {/* Hairline between permanent pins and transient unread, only
                    when both are present. */}
                {pinned.length > 0 && unread.length > 0 && (
                    <div className="my-1 h-px w-5 shrink-0 bg-sidebar-border/70"/>
                )}
                {unread.map((channel) => renderButton(channel))}
            </div>
        </div>
    );
}

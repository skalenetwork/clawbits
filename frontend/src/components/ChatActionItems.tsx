import {
    Logout01Icon as LogOut,
    Delete02Icon as Trash,
    Notification03Icon as Bell,
    NotificationOff02Icon as BellOff,
    PinIcon as Pin,
    PinOffIcon as PinOff,
    Copy01Icon,
    LinkSquare02Icon,
    ArrowUpRight01Icon,
} from "@hugeicons/core-free-icons";
import type {IconSvgElement} from "@hugeicons/react";
import {Icon} from "@/components/Icon";
import {ContextMenuItem, ContextMenuSeparator} from "@/components/ui/context-menu";
import {Drawer, DrawerContent, DrawerHeader, DrawerTitle} from "@/components/ui/drawer";
import type {MmChannel} from "@/lib/api";
import {formatChannelTitle} from "@/lib/formatting";
import type {ChannelActions} from "@/hooks/useChannelActions";
import {cn} from "@/lib/utils";

/**
 * The single source of truth for a chat's per-conversation actions. Rendered as
 * right-click ``ContextMenuItem``s on desktop (sidebar rows + rail avatars) and
 * as a tappable bottom-sheet on mobile (long-press), so the two surfaces never
 * drift. The caller supplies a shared ``actions`` object (one
 * ``useChannelActions()`` per list) rather than each item creating its own.
 */
export function ChatContextMenuItems({
    channel,
    actions,
}: {
    channel: MmChannel;
    actions: ChannelActions;
}) {
    const isPinned = Boolean(channel.pinned);
    const muted = Boolean(channel.muted);
    const channelPath = `/channels/${channel.channel_id}`;
    return (
        <>
            <ContextMenuItem onClick={() => { window.open(channelPath, "_blank", "noopener,noreferrer"); }}>
                <Icon icon={ArrowUpRight01Icon}/> Open in new tab
            </ContextMenuItem>
            <ContextMenuItem onClick={() => { actions.copyLink(channel); }}>
                <Icon icon={LinkSquare02Icon}/> Copy link
            </ContextMenuItem>
            <ContextMenuItem onClick={() => { actions.copyId(channel); }}>
                <Icon icon={Copy01Icon}/> Copy channel ID
            </ContextMenuItem>
            <ContextMenuSeparator/>
            <ContextMenuItem onClick={() => { actions.togglePin(channel); }}>
                <Icon icon={isPinned ? PinOff : Pin}/> {isPinned ? "Unpin" : "Pin"}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => { actions.toggleMute(channel); }}>
                <Icon icon={muted ? Bell : BellOff}/> {muted ? "Unmute" : "Mute"}
            </ContextMenuItem>
            <ContextMenuItem
                variant="destructive"
                onClick={() => { actions.leave(channel); }}
            >
                <Icon icon={LogOut}/> Leave channel
            </ContextMenuItem>
            {actions.canDelete(channel) && (
                <ContextMenuItem
                    variant="destructive"
                    onClick={() => { actions.deleteChannel(channel); }}
                >
                    <Icon icon={Trash}/> Delete channel
                </ContextMenuItem>
            )}
        </>
    );
}

/** One tappable row inside the mobile action sheet. */
function SheetRow({
    icon,
    label,
    destructive,
    onSelect,
}: {
    icon: IconSvgElement;
    label: string;
    destructive?: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                "flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left text-[15px] font-medium transition active:scale-[0.99] active:bg-foreground/5 [&_svg]:size-5 [&_svg]:shrink-0",
                destructive
                    ? "text-destructive [&_svg]:text-destructive"
                    : "text-foreground [&_svg]:text-muted-foreground",
            )}
        >
            <Icon icon={icon}/>
            {label}
        </button>
    );
}

/**
 * Mobile counterpart to the right-click menu: a bottom sheet of the same chat
 * actions, opened by long-pressing a conversation (in the pinned strip or the
 * list). Pin/Unpin first so the most common reason to long-press is the top hit.
 */
export function ChatActionSheet({
    channel,
    actions,
    open,
    onOpenChange,
}: {
    channel: MmChannel;
    actions: ChannelActions;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const isPinned = Boolean(channel.pinned);
    const muted = Boolean(channel.muted);
    const title = formatChannelTitle(channel.display_name ?? channel.name);
    const run = (fn: () => void) => {
        onOpenChange(false);
        fn();
    };
    return (
        <Drawer open={open} onOpenChange={onOpenChange}>
            <DrawerContent>
                <DrawerHeader>
                    <DrawerTitle>{title}</DrawerTitle>
                </DrawerHeader>
                <div className="flex flex-col gap-0.5 pb-2">
                    <SheetRow
                        icon={isPinned ? PinOff : Pin}
                        label={isPinned ? "Unpin" : "Pin"}
                        onSelect={() => { run(() => { actions.togglePin(channel); }); }}
                    />
                    <SheetRow
                        icon={muted ? Bell : BellOff}
                        label={muted ? "Unmute" : "Mute"}
                        onSelect={() => { run(() => { actions.toggleMute(channel); }); }}
                    />
                    <SheetRow
                        icon={LogOut}
                        label="Leave channel"
                        destructive
                        onSelect={() => { run(() => { actions.leave(channel); }); }}
                    />
                    {actions.canDelete(channel) && (
                        <SheetRow
                            icon={Trash}
                            label="Delete channel"
                            destructive
                            onSelect={() => { run(() => { actions.deleteChannel(channel); }); }}
                        />
                    )}
                </div>
            </DrawerContent>
        </Drawer>
    );
}

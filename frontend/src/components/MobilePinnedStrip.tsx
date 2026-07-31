import {ChannelGlyph} from "@/components/ChannelGlyph";
import {useLongPress} from "@/hooks/useLongPress";
import {formatChannelTitle} from "@/lib/formatting";
import type {MmChannel} from "@/lib/api";
import {cn} from "@/lib/utils";

/** One pinned conversation in the strip: a species-shaped avatar with a
 *  corner unread indicator and a single-line name below it. Tap opens;
 *  press-and-hold (touch) opens the action sheet so the chat can be
 *  unpinned/muted/left. */
function PinnedContact({
    channel,
    onOpen,
    onLongPress,
}: {
    channel: MmChannel;
    onOpen: () => void;
    onLongPress: () => void;
}) {
    const longPress = useLongPress(onLongPress);
    const label = formatChannelTitle(channel.display_name ?? channel.name);
    const unread = channel.unread_count ?? 0;
    const mentionCount = channel.unread_mention_count ?? 0;
    const hasMention = mentionCount > 0;
    const muted = Boolean(channel.muted);
    const isDm = channel.channel_type === "direct";
    // Same unread ladder as everywhere else: red @N for mentions (pierces
    // mute), red count for DM unreads, an ink dot for channel chatter,
    // nothing when muted.
    const showsCount = unread > 0 && !muted && isDm;
    const showsDot = unread > 0 && !muted && !isDm;
    return (
        <button
            type="button"
            onClick={onOpen}
            {...longPress}
            aria-label={unread > 0 ? `${label}, ${String(unread)} unread` : label}
            className="flex min-w-0 flex-col items-center gap-1.5 transition active:scale-95"
        >
            <span className="relative flex">
                <ChannelGlyph channel={channel} size={56}/>
                {hasMention ? (
                    <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-unread px-1 py-0.5 text-center text-[11px] font-semibold leading-none tabular-nums text-white shadow-sm ring-2 ring-background">
                        @{mentionCount > 99 ? "99+" : mentionCount}
                    </span>
                ) : showsCount ? (
                    <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-unread px-1 py-0.5 text-center text-[11px] font-semibold leading-none tabular-nums text-white shadow-sm ring-2 ring-background">
                        {unread > 99 ? "99+" : unread}
                    </span>
                ) : showsDot ? (
                    <span
                        role="img"
                        aria-label={`${String(unread)} unread`}
                        className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-foreground/80 ring-2 ring-background"
                    />
                ) : null}
            </span>
            <span
                className={cn(
                    "w-full truncate text-center text-[11px] leading-tight",
                    hasMention || (unread > 0 && !muted) ? "font-medium text-foreground" : "text-muted-foreground",
                )}
            >
                {label}
            </span>
        </button>
    );
}

/**
 * The mobile "pinned" strip: a contacts-style 4-column grid of pinned
 * conversations above the chat tabs (avatar + name + unread badge), the touch
 * counterpart to the desktop rail's pins cluster. The caller caps and orders
 * the list (newest-active first, max 4 — one full row) and only renders the
 * strip when there is at least one pin; it sits above the tabs with no divider.
 */
export function MobilePinnedStrip({
    channels,
    onOpen,
    onLongPress,
}: {
    channels: MmChannel[];
    onOpen: (channel: MmChannel) => void;
    onLongPress: (channel: MmChannel) => void;
}) {
    return (
        <div className="-mx-3 px-3 py-3">
            <div className="grid grid-cols-4 gap-2">
                {channels.map((channel) => (
                    <PinnedContact
                        key={channel.channel_id}
                        channel={channel}
                        onOpen={() => { onOpen(channel); }}
                        onLongPress={() => { onLongPress(channel); }}
                    />
                ))}
            </div>
        </div>
    );
}

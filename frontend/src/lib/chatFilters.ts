import {useCallback, useState} from "react";
import {
    BubbleChatIcon,
    HashtagIcon,
    Message01Icon,
} from "@hugeicons/core-free-icons";
import type {IconSvgElement} from "@hugeicons/react";
import type {MmChannel} from "@/lib/api";

/** The scope filter shown as tabs at the top of the chat list. */
export type ChatTab = "all" | "channels" | "dms";

/** Tab descriptors in display order — drives the segmented control. */
export const CHAT_TABS: {id: ChatTab; label: string; icon: IconSvgElement}[] = [
    {id: "all", label: "All", icon: BubbleChatIcon},
    {id: "channels", label: "Channels", icon: HashtagIcon},
    {id: "dms", label: "DMs", icon: Message01Icon},
];

/** Recency key — newest activity first. Falls back to ``created_at`` for
 *  channels with no messages yet, then 0 for legacy rows missing both. */
export function activityTime(c: MmChannel): number {
    const at = c.last_message_at ?? c.created_at;
    return at ? new Date(at).getTime() : 0;
}

/** The channels matching a scope tab. ``all`` is the full set; ``channels``
 *  is everything that isn't a DM; ``dms`` is the direct channels. */
export function filterChannelsByTab(channels: MmChannel[], tab: ChatTab): MmChannel[] {
    if (tab === "channels") return channels.filter((c) => c.channel_type !== "direct");
    if (tab === "dms") return channels.filter((c) => c.channel_type === "direct");
    return channels;
}

/** A newest-activity-first copy of the list (does not mutate the input). */
export function sortByRecency(channels: MmChannel[]): MmChannel[] {
    return [...channels].sort((a, b) => activityTime(b) - activityTime(a));
}

const CHAT_TAB_STORAGE_KEY = "fc_chats_tab";

function isChatTab(v: string | null): v is ChatTab {
    return v === "all" || v === "channels" || v === "dms";
}

/**
 * The persisted scope-tab selection. Stored in ``localStorage`` (mirroring the
 * ``CollapsibleGroup`` pattern) so the user's filter survives reloads and
 * follows them across viewports — the desktop sidebar and the mobile chats
 * screen share this key. They're never mounted at the same time (the shell
 * picks one), so a single localStorage value is enough to keep them in sync.
 */
export function useChatTab(): [ChatTab, (tab: ChatTab) => void] {
    const [tab, setTabState] = useState<ChatTab>(() => {
        const stored = localStorage.getItem(CHAT_TAB_STORAGE_KEY);
        return isChatTab(stored) ? stored : "all";
    });
    const setTab = useCallback((next: ChatTab) => {
        setTabState(next);
        localStorage.setItem(CHAT_TAB_STORAGE_KEY, next);
    }, []);
    return [tab, setTab];
}

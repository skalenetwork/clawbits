import {useCallback, useState} from "react";
import {
  BubbleChatIcon,
  HashtagIcon,
  Message01Icon,
} from "@hugeicons/core-free-icons";
import { Bot } from "lucide-react";
import type {AppIcon} from "@/components/Icon";
import type {MmChannel} from "@/lib/api";

/** The scope filter shown as tabs at the top of the chat list. */
export type ChatTab = "all" | "channels" | "dms" | "agents";

/** Tab descriptors in display order — drives the segmented control. */
export const CHAT_TABS: {id: ChatTab; label: string; icon: AppIcon}[] = [
    {id: "all", label: "All", icon: BubbleChatIcon},
    {id: "channels", label: "Channels", icon: HashtagIcon},
    {id: "dms", label: "DMs", icon: Message01Icon},
    {id: "agents", label: "Agents", icon: Bot},
];

export function isPairType(t: string | undefined): boolean {
    return t === "direct" || t === "agent_chat";
}

export function isPairChannel(c: Pick<MmChannel, "channel_type">): boolean {
    return isPairType(c.channel_type);
}

/** Newest activity first; ``created_at`` if never messaged, else 0. */
export function activityTime(c: MmChannel): number {
    const at = c.last_message_at ?? c.created_at;
    return at ? new Date(at).getTime() : 0;
}

/** The channels matching a scope tab. ``all`` is the full set; ``channels``
 *  is rooms; ``dms`` is human 1:1s; ``agents`` is agent inboxes and named chats. */
export function filterChannelsByTab(channels: MmChannel[], tab: ChatTab): MmChannel[] {
    if (tab === "channels") return channels.filter((c) => !isPairChannel(c));
    if (tab === "dms") return channels.filter((c) => isPairChannel(c) && c.dm_peer_agent_id == null);
    if (tab === "agents") return channels.filter((c) => isPairChannel(c) && c.dm_peer_agent_id != null);
    return channels;
}

/** A newest-activity-first copy of the list (does not mutate the input). */
export function sortByRecency(channels: MmChannel[]): MmChannel[] {
    return [...channels].sort((a, b) => activityTime(b) - activityTime(a));
}

export interface AgentChatGroup {
    agentId: string;
    inbox: MmChannel | null;
    chats: MmChannel[];
}

/** Agents-tab clusters: inbox first, named chats by recency, groups by latest activity. */
export function groupAgentChats(channels: MmChannel[]): AgentChatGroup[] {
    const map = new Map<string, AgentChatGroup>();
    for (const c of channels) {
        const agentId = c.dm_peer_agent_id;
        if (!agentId) continue;
        let g = map.get(agentId);
        if (!g) {
            g = {agentId, inbox: null, chats: []};
            map.set(agentId, g);
        }
        if (c.channel_type === "direct") g.inbox = c;
        else g.chats.push(c);
    }
    const latest = (g: AgentChatGroup) =>
        Math.max(g.inbox ? activityTime(g.inbox) : 0, ...g.chats.map(activityTime));
    for (const g of map.values()) g.chats.sort((a, b) => activityTime(b) - activityTime(a));
    return [...map.values()].sort((a, b) => latest(b) - latest(a));
}

const CHAT_TAB_STORAGE_KEY = "fc_chats_tab";

function isChatTab(v: string | null): v is ChatTab {
    return CHAT_TABS.some((t) => t.id === v);
}

/** Scope tab shared by sidebar and mobile chats. */
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

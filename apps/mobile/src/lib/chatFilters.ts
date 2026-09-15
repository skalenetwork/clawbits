import type { Channel } from "./models";

export const CHAT_TABS = ["all", "channels", "dms", "agents"] as const;
export type ChatTab = (typeof CHAT_TABS)[number];

export const CHAT_TAB_LABEL: Record<ChatTab, string> = {
  all: "All",
  channels: "Channels",
  dms: "DMs",
  agents: "Agents",
};

export function filterChannelsByTab(
  channels: Channel[],
  tab: ChatTab,
): Channel[] {
  if (tab === "channels")
    return channels.filter((channel) => channel.channel_type !== "direct");
  if (tab === "dms")
    return channels.filter((channel) => channel.channel_type === "direct");
  if (tab === "agents")
    return channels.filter(
      (channel) =>
        channel.channel_type === "direct" && channel.dm_peer_agent_id != null,
    );
  return channels;
}

export function listTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function previewText(channel: Channel, userId: number): string {
  const text = channel.last_message_text?.replace(/\s+/g, " ").trim();
  if (text) {
    const own = channel.last_message_author_human_id === userId;
    if (channel.channel_type === "direct")
      return own ? `You: ${text}` : text;
    const name = channel.last_message_author_display_name?.trim().split(/\s+/)[0];
    const who = own ? "You" : name;
    return who ? `${who}: ${text}` : text;
  }
  if (channel.last_message_attachment_count)
    return channel.last_message_attachment_count === 1
      ? "Attachment"
      : `${channel.last_message_attachment_count} attachments`;
  return channel.channel_type === "direct" ? "Start a conversation" : "No messages";
}

export function glyphKind(channel: Channel): "human" | "agent" | "channel" {
  if (channel.channel_type !== "direct") return "channel";
  return channel.dm_peer_agent_id ? "agent" : "human";
}

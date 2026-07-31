import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/context/AuthContext";
import { listMmChannels, type MmChannel } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { formatChannelTitle, formatRelativeShort } from "@/lib/formatting";
import { useMessageDrafts } from "@/hooks/useMessageDrafts";
import { useChannelActions } from "@/hooks/useChannelActions";
import { ChannelGlyph } from "@/components/ChannelGlyph";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ui/list-row";
import { ChatTabs } from "@/components/ChatTabs";
import { ChatActionSheet } from "@/components/ChatActionItems";
import { MobilePinnedStrip } from "@/components/MobilePinnedStrip";
import {
  filterChannelsByTab,
  sortByRecency,
  useChatTab,
} from "@/lib/chatFilters";

/** How many pinned conversations the mobile strip shows; the rest stay in the
 *  list below (still pinned, just not surfaced in the strip). */
const MAX_PINNED_STRIP = 4;

/**
 * The mobile "Chats" tab: a horizontal pinned-contacts strip, an All / Channels
 * / DMs scope filter, and a single recency-sorted conversation list filtered by
 * the active tab. Rendered by AgentHomePage when the viewport is mobile. Reuses
 * the shared channels query (same cache key as the shell badge + desktop
 * sidebar, so no extra fetch), the per-device draft previews, and the shared
 * per-channel actions (long-press → action sheet).
 */
export function MobileChatsScreen() {
  const { user, activeOrgId } = useAuth();
  const navigate = useNavigate();
  const drafts = useMessageDrafts(user?.id);
  const actions = useChannelActions();
  const [tab, setTab] = useChatTab();
  const [actionTarget, setActionTarget] = useState<MmChannel | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const channelsQuery = useQuery({
    queryKey: queryKeys.mm.channels(activeOrgId ?? null),
    queryFn: () => listMmChannels(activeOrgId ?? null),
    enabled: Boolean(activeOrgId),
  });

  const all = channelsQuery.data?.channels ?? [];
  // Pins get their own strip (newest-active first, capped); the list itself is
  // pure recency with pins left in place — no longer floated to the top.
  const pinned = sortByRecency(all.filter((c) => c.pinned)).slice(0, MAX_PINNED_STRIP);
  const list = sortByRecency(filterChannelsByTab(all, tab));

  const openActions = (channel: MmChannel) => {
    setActionTarget(channel);
    setSheetOpen(true);
  };

  const renderSubtitle = (channel: MmChannel): ReactNode => {
    const isDm = channel.channel_type === "direct";
    const preview = channel.last_message_text ?? null;
    const attachmentCount = channel.last_message_attachment_count ?? 0;
    const authorName = channel.last_message_author_display_name ?? null;
    const isOwn =
      user?.id != null && channel.last_message_author_human_id === user.id;

    const draftText = drafts.get(channel.channel_id)?.text.trim() ?? "";
    if (draftText) {
      return (
        <>
          <span className="font-medium text-destructive">Draft:</span>{" "}
          {draftText.replace(/\s+/g, " ")}
        </>
      );
    }
    if (preview) {
      // Channel previews use a first-name author prefix ("kai: …"), matching
      // the desktop sidebar; own messages become "You:" in both scopes.
      const authorFirstName = authorName?.trim().split(/\s+/)[0] ?? null;
      const prefix = isOwn
        ? "You: "
        : isDm
          ? ""
          : authorFirstName
            ? `${authorFirstName}: `
            : "";
      return `${prefix}${preview}`;
    }
    if (attachmentCount > 0) {
      return attachmentCount === 1 ? "Attachment" : `${String(attachmentCount)} attachments`;
    }
    return <span className="text-muted-foreground/70">No messages</span>;
  };

  const emptyLabel = channelsQuery.isLoading
    ? "Loading conversations…"
    : tab === "dms"
      ? "No direct messages yet."
      : tab === "channels"
        ? "No channels yet."
        : "No conversations yet. Tap + to start one.";

  return (
    <>
      <PageHeader title="Chats" />

      {pinned.length > 0 && (
        <MobilePinnedStrip
          channels={pinned}
          onOpen={(channel) => {
            void navigate(`/channels/${channel.channel_id}`, { viewTransition: true });
          }}
          onLongPress={openActions}
        />
      )}

      <ChatTabs value={tab} onValueChange={setTab} fill className="w-full pb-2 pt-1" />

      {list.length === 0 ? (
        <p className="px-4 py-16 text-center text-sm text-muted-foreground">
          {emptyLabel}
        </p>
      ) : (
        <div className="-mx-3 flex flex-col">
          {list.map((channel, i) => {
            const unread = channel.unread_count ?? 0;
            const mentionCount = channel.unread_mention_count ?? 0;
            const hasMention = mentionCount > 0;
            const muted = Boolean(channel.muted);
            const isDm = channel.channel_type === "direct";
            // Same unread ladder as the desktop sidebar + rail: red @N for
            // mentions (pierces mute), red count for DM unreads, an ink dot
            // for channel chatter, nothing when muted (row renders dimmed).
            const hasUnread = unread > 0 && !muted;
            const showsBold = hasMention || hasUnread;
            return (
              <ListRow
                key={channel.channel_id}
                divider={i < list.length - 1}
                onClick={() => {
                  void navigate(`/channels/${channel.channel_id}`, { viewTransition: true });
                }}
                onLongPress={() => {
                  openActions(channel);
                }}
                leading={
                  <ChannelGlyph
                    channel={channel}
                    size={44}
                    className={muted ? "opacity-60" : undefined}
                  />
                }
                title={
                  <span className={`${showsBold ? "font-semibold" : "font-medium"} ${muted ? "opacity-60" : ""}`}>
                    {formatChannelTitle(channel.display_name ?? channel.name)}
                  </span>
                }
                subtitle={
                  muted ? (
                    <span className="opacity-60">{renderSubtitle(channel)}</span>
                  ) : (
                    renderSubtitle(channel)
                  )
                }
                trailing={
                  <>
                    <span className="text-muted-foreground tabular-nums">
                      {formatRelativeShort(
                        channel.last_message_at ?? channel.created_at,
                      )}
                    </span>
                    {hasMention ? (
                      <span
                        className="rounded-full bg-unread px-1.5 py-0.5 text-[11px] font-semibold tabular-nums leading-none text-white"
                        aria-label={`${String(mentionCount)} mention${mentionCount === 1 ? "" : "s"}`}
                      >
                        @{mentionCount > 99 ? "99+" : mentionCount}
                      </span>
                    ) : hasUnread && isDm ? (
                      <span
                        className="rounded-full bg-unread px-1.5 py-0.5 text-[11px] font-semibold tabular-nums leading-none text-white"
                        aria-label={`${String(unread)} unread`}
                      >
                        {unread > 99 ? "99+" : unread}
                      </span>
                    ) : hasUnread ? (
                      <span
                        role="img"
                        aria-label={`${String(unread)} unread`}
                        className="size-2 rounded-full bg-foreground/75"
                      />
                    ) : null}
                  </>
                }
              />
            );
          })}
        </div>
      )}

      {actionTarget && (
        <ChatActionSheet
          channel={actionTarget}
          actions={actions}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
        />
      )}
    </>
  );
}

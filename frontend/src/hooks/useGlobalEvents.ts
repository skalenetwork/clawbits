import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { openSseStream } from "@/lib/sse";
import { queryKeys } from "@/lib/queryKeys";
import { updateAgentPresence } from "@/hooks/useAgentPresence";
import { updateUserPresence } from "@/hooks/useUserPresence";
import { useLatestRef } from "@/hooks/useLatestRef";
import type { AgentLivenessStatus, GlobalUserStatus, MmChannel, MmChannelPost, Org } from "@/lib/api";
import { isDesktop, notifyForPost } from "@/lib/desktop";
import { channelListTitle } from "@/lib/formatting";
import { isPairChannel } from "@/lib/chatFilters";
import { messageMentionsViewer, selfMentionTokens } from "@/lib/mentions";
import { toast } from "@/lib/toast";

type ChannelsCache = { channels: MmChannel[]; total: number };
type OrgsCache = { organizations: Org[]; total: number };

type GlobalEvent =
  | { type: "post.created"; channel_id: string; data: MmChannelPost }
  | { type: "post.deleted"; channel_id: string; data: { post_id: number } }
  | { type: "channel.read"; channel_id: string; data: { last_read_post_id: number } }
  | { type: "channel.muted"; channel_id: string; data: { muted: boolean } }
  | { type: "channel.pinned"; channel_id: string; data: { pinned: boolean } }
  | { type: "channel.added"; channel_id: string; data: MmChannel }
  | { type: "channel.removed"; channel_id: string; data: { channel_id: string } }
  | { type: "org.added" | "org.updated"; channel_id: string; data: Org }
  | {
      type: "user.status";
      channel_id: string;
      data: { human_id: number; status: GlobalUserStatus; last_seen_at: string | null; last_seen_label?: string | null };
    }
  | {
      type: "agent.status";
      channel_id: string;
      data: { agent_id: string; status: AgentLivenessStatus; last_alive_at: string | null };
    }
  | { type: "server.hello"; channel_id: string; data: { version: string } };

const byRecency = (a: MmChannel, b: MmChannel) => {
  const ta = a.last_message_at ?? a.created_at;
  const tb = b.last_message_at ?? b.created_at;
  return ta < tb ? 1 : ta > tb ? -1 : 0;
};

/** Mirrors the web push `_preview` (clawbits/realtime/web_push.py): one line, never an empty banner. */
function notificationBody(preview: string, attachments: number): string {
  const text = preview.replace(/\s+/g, " ").trim();
  if (text) return text;
  if (attachments === 1) return "Sent an attachment";
  return attachments > 1 ? `Sent ${String(attachments)} attachments` : "New message";
}

function patchChannels(qc: QueryClient, update: (prev: ChannelsCache) => ChannelsCache): void {
  qc.setQueriesData<ChannelsCache>({ queryKey: queryKeys.mm.channelsAll }, (prev) => prev && update(prev));
}

function patchChannel(qc: QueryClient, channelId: string, update: (c: MmChannel) => MmChannel, resort = false): void {
  patchChannels(qc, (prev) => {
    if (!prev.channels.some((c) => c.channel_id === channelId)) return prev;
    const channels = prev.channels.map((c) => (c.channel_id === channelId ? update(c) : c));
    return { ...prev, channels: resort ? channels.sort(byRecency) : channels };
  });
}

function cachedChannels(qc: QueryClient): MmChannel[] {
  return qc.getQueriesData<ChannelsCache>({ queryKey: queryKeys.mm.channelsAll }).flatMap(([, data]) => data?.channels ?? []);
}

/** The per-user SSE stream, open for the whole signed-in session. Everything reads through refs, because a
 *  reconnect loses whatever was fanned out meanwhile: the stream has no replay. */
export function useGlobalEvents(): void {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const userRef = useLatestRef(user);
  const activeChannelIdRef = useLatestRef(/^\/channels\/([^/]+)/.exec(pathname)?.[1] ?? null);
  const navigateRef = useLatestRef(navigate);
  const firstOpenRef = useRef(true);
  const promptedVersionRef = useRef<string | null>(null);
  const enabled = user !== null;

  useEffect(() => {
    if (!enabled) return;

    const conn = openSseStream("/api/human/events", (raw) => {
      const evt = raw as GlobalEvent;

      if (evt.type === "post.created") {
        const post = evt.data;
        if (post.status === "draft" || post.status === "rejected") return;
        if (post.status === "streaming") {
          patchChannel(qc, evt.channel_id, (c) => ({ ...c, working: true }));
          return;
        }
        patchChannel(qc, evt.channel_id, (c) => (c.working ? { ...c, working: false } : c));
        const me = userRef.current;
        const isOwnPost = me !== null && post.human_id === me.id;
        const skipUnread = isOwnPost || evt.channel_id === activeChannelIdRef.current;
        const mentionsMe = !skipUnread && messageMentionsViewer(post.message ?? "", selfMentionTokens(me));
        if (!isOwnPost && !cachedChannels(qc).some((c) => c.channel_id === evt.channel_id)) {
          void qc.invalidateQueries({ queryKey: queryKeys.orgs });
        }
        const preview = (post.message ?? "").slice(0, 100);
        const attachments = (post.files ?? []).filter((f) => f.status === "uploaded").length;
        patchChannel(
          qc,
          evt.channel_id,
          (c) => ({
            ...c,
            last_message_at: post.created_at,
            last_message_text: preview,
            last_message_author_human_id: post.human_id,
            last_message_author_agent_id: post.agent_id,
            last_message_author_display_name: post.poster_display_name,
            last_message_author_avatar: post.avatar ?? null,
            last_message_attachment_count: attachments,
            unread_count: (c.unread_count ?? 0) + (skipUnread ? 0 : 1),
            unread_mention_count: (c.unread_mention_count ?? 0) + (mentionsMe ? 1 : 0),
          }),
          true,
        );
        if (skipUnread) return;
        const channel = cachedChannels(qc).find((c) => c.channel_id === evt.channel_id);
        if (!channel || channel.muted) return;
        const title = channelListTitle(channel);
        void notifyForPost({
          channelId: evt.channel_id,
          channelName: isPairChannel(channel) ? title : `#${title}`,
          authorName: post.poster_display_name ?? "Someone",
          body: notificationBody(preview, attachments),
        });
      } else if (evt.type === "post.deleted") {
        void qc.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      } else if (evt.type === "channel.read") {
        patchChannel(qc, evt.channel_id, (c) => ({ ...c, unread_count: 0, unread_mention_count: 0 }));
        void qc.invalidateQueries({ queryKey: queryKeys.orgs });
      } else if (evt.type === "channel.muted") {
        patchChannel(qc, evt.channel_id, (c) => ({ ...c, muted: evt.data.muted }));
      } else if (evt.type === "channel.pinned") {
        patchChannel(qc, evt.channel_id, (c) => ({ ...c, pinned: evt.data.pinned }));
      } else if (evt.type === "channel.added") {
        const incoming = evt.data;
        qc.setQueryData(queryKeys.mm.channel(incoming.channel_id), incoming);
        patchChannels(qc, (prev) => {
          const exists = prev.channels.some((c) => c.channel_id === incoming.channel_id);
          return {
            channels: exists
              ? prev.channels.map((c) => (c.channel_id === incoming.channel_id ? incoming : c))
              : [incoming, ...prev.channels].sort(byRecency),
            total: exists ? prev.total : prev.total + 1,
          };
        });
        void qc.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      } else if (evt.type === "channel.removed") {
        patchChannels(qc, (prev) => {
          const channels = prev.channels.filter((c) => c.channel_id !== evt.channel_id);
          return channels.length === prev.channels.length ? prev : { channels, total: prev.total - 1 };
        });
        if (evt.channel_id === activeChannelIdRef.current) void navigateRef.current("/home");
      } else if (evt.type === "org.added" || evt.type === "org.updated") {
        const incoming = evt.data;
        qc.setQueryData<OrgsCache>(queryKeys.orgs, (prev) => {
          if (!prev) return prev;
          if (prev.organizations.some((o) => o.org_id === incoming.org_id)) {
            return {
              ...prev,
              organizations: prev.organizations.map((o) => (o.org_id === incoming.org_id ? { ...o, ...incoming } : o)),
            };
          }
          return evt.type === "org.added"
            ? { ...prev, organizations: [...prev.organizations, incoming], total: prev.total + 1 }
            : prev;
        });
        if (evt.type === "org.updated") void qc.invalidateQueries({ queryKey: queryKeys.orgMembers(incoming.org_id) });
      } else if (evt.type === "user.status") {
        updateUserPresence([{
          humanId: evt.data.human_id,
          status: evt.data.status,
          lastSeenAt: evt.data.last_seen_at,
          lastSeenLabel: evt.data.last_seen_label ?? null,
        }]);
      } else if (evt.type === "agent.status") {
        updateAgentPresence([{ agentId: evt.data.agent_id, lastAliveAt: evt.data.last_alive_at }]);
      } else if (evt.type === "server.hello") {
        const version = evt.data.version;
        // The desktop app updates through Tauri's updater; a reload would not fetch a new build.
        if (isDesktop || !version || version === __BUILD_VERSION__ || version === promptedVersionRef.current) return;
        promptedVersionRef.current = version;
        toast("A new version is available", {
          id: "app-update",
          description: "Refresh to load the latest update.",
          duration: Infinity,
          action: { label: "Refresh", onClick: () => window.location.reload() },
        });
      }
    }, {
      onOpen: () => {
        // Reconcile on reconnect only: the shell's own fetch covers the first open.
        if (firstOpenRef.current) {
          firstOpenRef.current = false;
          return;
        }
        void qc.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
        void qc.invalidateQueries({ queryKey: queryKeys.orgs });
      },
    });

    return () => { conn.close(); };
  }, [enabled, qc, userRef, activeChannelIdRef, navigateRef]);
}

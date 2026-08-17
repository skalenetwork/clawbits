import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { openSseStream } from "@/lib/sse";
import { queryKeys } from "@/lib/queryKeys";
import { useAgentPresence } from "@/hooks/useAgentPresence";
import { useUserPresence } from "@/hooks/useUserPresence";
import type { AgentLivenessStatus, GlobalUserStatus, MmChannel, MmChannelPost, Org } from "@/lib/api";
import { isDesktop, notifyForPost } from "@/lib/desktop";
import { formatChannelTitle } from "@/lib/formatting";
import { messageMentionsViewer } from "@/lib/mentions";
import { toast } from "@/lib/toast";

const EMPTY_TOKENS: ReadonlySet<string> = new Set<string>();

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
  | { type: "org.added"; channel_id: string; data: Org }
  | { type: "org.updated"; channel_id: string; data: Org }
  | {
      type: "user.status";
      channel_id: string;
      data: {
        human_id: number;
        status: GlobalUserStatus;
        last_seen_at: string | null;
        /** Bucketed "Last seen recently" string when the user hid
         *  their precise last-seen; null when the timestamp is exposed. */
        last_seen_label?: string | null;
      };
    }
  | {
      type: "agent.status";
      channel_id: string;
      data: {
        agent_id: string;
        status: AgentLivenessStatus;
        last_alive_at: string | null;
      };
    }
  // First frame of the stream (and of every reconnect): the running
  // server's version, so a tab on a stale bundle can prompt a reload.
  | { type: "server.hello"; channel_id: string; data: { version: string } };

interface UseGlobalEventsOptions {
  /** Current user's local human id. Skips unread-counting on own posts. */
  currentUserId: number | null;
  /** Lowercased ``@mention`` tokens that resolve to the current user (see
   *  ``selfMentionTokens``). Lets the optimistic post.created patch light up
   *  the sidebar's "mentioned" badge the instant a post addressing the user
   *  (or ``@here``) arrives, before the next channel-list refetch. */
  selfMentionTokens?: ReadonlySet<string>;
  /** Channel currently in focus (URL match). Posts arriving here aren't
   *  counted as unread because the channel view will mark them read. */
  activeChannelId: string | null;
  /** Disabled until auth resolves. */
  enabled: boolean;
  /** Fired when the user is removed from a channel they're currently
   *  viewing (kicked, or self-leave from another tab). The layout uses
   *  this to navigate them away from the now-inaccessible URL. */
  onChannelRemoved?: (channelId: string) => void;
}

/** Apply ``update`` to one channel in every org-scoped channels-list cache.
 *  Caches keyed by `["mm","channels",<orgId>]`, so we patch all matching
 *  entries — the no-op branch handles caches that don't contain this
 *  channel. Optionally resort by ``last_message_at`` so a freshly-active
 *  channel surfaces. */
function patchChannel(
  qc: QueryClient,
  channelId: string,
  update: (c: MmChannel) => MmChannel,
  resort = false,
): void {
  qc.setQueriesData<ChannelsCache>(
    { queryKey: queryKeys.mm.channelsAll },
    (prev) => {
      if (!prev) return prev;
      const idx = prev.channels.findIndex((c) => c.channel_id === channelId);
      if (idx < 0) return prev;
      const channel = prev.channels[idx];
      if (!channel) return prev;
      const next = prev.channels.slice();
      next[idx] = update(channel);
      if (resort) {
        next.sort((a, b) => {
          const ta = a.last_message_at ?? a.created_at;
          const tb = b.last_message_at ?? b.created_at;
          return ta < tb ? 1 : ta > tb ? -1 : 0;
        });
      }
      return { ...prev, channels: next };
    },
  );
}

/**
 * Subscribe to the per-user global SSE stream. Drives sidebar unread
 * counters, cross-tab read sync, mute sync, and sidebar membership
 * updates (channel.added / channel.removed) by mutating the
 * `["mm","channels"]` query cache directly. The per-channel stream
 * (`useChannelEvents`) stays for in-channel concerns.
 */
export function useGlobalEvents({
  currentUserId,
  selfMentionTokens,
  activeChannelId,
  enabled,
  onChannelRemoved,
}: UseGlobalEventsOptions): void {
  const qc = useQueryClient();
  const presence = useUserPresence();
  const agentPresence = useAgentPresence();
  // Stable callback handle so callers don't have to memoize. The effect
  // below depends on (enabled, currentUserId, activeChannelId, qc) only —
  // reading through the ref keeps `onChannelRemoved` identity changes
  // from re-opening the SSE connection on every render.
  const onChannelRemovedRef = useRef(onChannelRemoved);
  onChannelRemovedRef.current = onChannelRemoved;
  // Distinguishes the initial connect from a reconnect — see ``onOpen``.
  // Lives outside the effect so a re-subscribe (org switch, auth change)
  // does not reset it back to "first".
  const firstOpenRef = useRef(true);
  // Same trick for the presence updater so context churn doesn't
  // reconnect the SSE pump.
  const presenceRef = useRef(presence);
  presenceRef.current = presence;
  const agentPresenceRef = useRef(agentPresence);
  agentPresenceRef.current = agentPresence;
  // Read these through refs too, so the handler always sees the latest
  // values without the effect re-subscribing. Previously `activeChannelId`
  // was an effect dependency, which tore down and reopened the global
  // stream on every channel switch — and any post.created fanned out to
  // this user during that reconnect gap was lost (the per-user stream has
  // no replay), leaving the sidebar silently stale.
  const currentUserIdRef = useRef(currentUserId);
  currentUserIdRef.current = currentUserId;
  const selfMentionTokensRef = useRef(selfMentionTokens ?? EMPTY_TOKENS);
  selfMentionTokensRef.current = selfMentionTokens ?? EMPTY_TOKENS;
  const activeChannelIdRef = useRef(activeChannelId);
  activeChannelIdRef.current = activeChannelId;
  // The server version we've already surfaced the update toast for. The
  // server re-announces its version on every reconnect (including the
  // routine keepalive-driven ones), so without this guard a stale tab
  // would re-toast on each reconnect. Keyed by version string rather than a
  // boolean so a *second* deploy in the same session still prompts.
  const promptedVersionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const conn = openSseStream("/api/human/events", (raw) => {
      const evt = raw as GlobalEvent;

      if (evt.type === "post.created") {
        const post = evt.data;
        // Drafts / rejected posts have visibility constraints — skip.
        if (post.status === "draft" || post.status === "rejected") return;
        // Don't count own posts or posts in the channel currently open.
        const isOwnPost =
          currentUserIdRef.current != null && post.human_id === currentUserIdRef.current;
        const skipUnread = isOwnPost || evt.channel_id === activeChannelIdRef.current;
        // Does this post address me (``@<handle>`` or ``@here``)? Only
        // meaningful for posts that also count as unread — same gate as the
        // count below. Optimistic; reconciled by the next channel-list fetch.
        const mentionsMe =
          !skipUnread &&
          messageMentionsViewer(post.message ?? "", selfMentionTokensRef.current);
        // Cross-org bump: if this channel doesn't live in any loaded
        // channels cache, the post is from an org the user isn't
        // currently viewing. Refresh the orgs query so the switcher's
        // per-org unread aggregate picks it up. Skip own posts — those
        // never contribute to unread on the server either.
        if (!isOwnPost) {
          const caches = qc.getQueriesData<ChannelsCache>({ queryKey: queryKeys.mm.channelsAll });
          const inAnyChannelCache = caches.some(([, data]) =>
            data?.channels.some((c) => c.channel_id === evt.channel_id) ?? false,
          );
          if (!inAnyChannelCache) {
            void qc.invalidateQueries({ queryKey: queryKeys.orgs });
          }
        }
        // Truncate to match the server-side preview cap. SSE carries the
        // full post body for the in-channel feed; the sidebar only ever
        // line-clamps to one row, so storing >100 chars here is waste.
        const preview = (post.message ?? "").slice(0, 100);
        // Count only fully-uploaded files — pending / failed shouldn't
        // light up the paperclip indicator. Matches the backend's
        // ``status == "uploaded"`` filter in get_mm_channels_for_human.
        const attachmentCount = (post.files ?? []).filter(
          (f) => f.status === "uploaded",
        ).length;
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
            // The author's avatar lives on the post payload (the same
            // ``AvatarRef`` the channel-list endpoint resolves server-
            // side via ``_avatar_for_member``). Copy it onto the
            // channel's denormalised snippet field so the sidebar and
            // recents render the real image immediately — without
            // this, the snippet falls back to the initial-letter chip
            // until the next channel-list refetch.
            last_message_author_avatar: post.avatar ?? null,
            last_message_attachment_count: attachmentCount,
            unread_count: skipUnread
              ? c.unread_count ?? 0
              : (c.unread_count ?? 0) + 1,
            unread_mention_count: mentionsMe
              ? (c.unread_mention_count ?? 0) + 1
              : c.unread_mention_count ?? 0,
          }),
          true,
        );
        // Desktop notification (no-op on web). Fire only for posts that
        // would have incremented the unread count, and respect the
        // channel's mute state. Channel name + mute are read from the
        // freshly-patched cache.
        if (!skipUnread) {
          const caches = qc.getQueriesData<ChannelsCache>({ queryKey: queryKeys.mm.channelsAll });
          const channel = caches
            .flatMap(([, data]) => data?.channels ?? [])
            .find((c) => c.channel_id === evt.channel_id);
          if (channel && !channel.muted) {
            const titleName = formatChannelTitle(channel.display_name ?? channel.name);
            // Slack-style: prefix # so a notification's first glance
            // distinguishes channels from DMs (where the title is just
            // the other person's name and a "#" would be wrong).
            const isDirect = channel.channel_type === "direct";
            void notifyForPost({
              channelId: evt.channel_id,
              channelName: isDirect ? titleName : `#${titleName}`,
              authorName: post.poster_display_name ?? "Someone",
              body: preview,
            });
          }
        }
      } else if (evt.type === "post.deleted") {
        // The deleted post may have been the channel's last_message_*
        // snapshot — we don't have enough info here to recompute it
        // without a round-trip, so re-fetch the channels list. Cheap
        // (one query, no per-channel fan-out) and rare (deletes are
        // user-initiated, not streamed).
        void qc.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      } else if (evt.type === "channel.read") {
        patchChannel(qc, evt.channel_id, (c) => ({
          ...c,
          unread_count: 0,
          unread_mention_count: 0,
        }));
        // Cross-org sync: a read pointer change in any org might shift the
        // switcher's per-org aggregate. Refetch is cheap — channel.read
        // fires sparsely (on channel entry, not per post) — and saves us
        // from doing the per-org subtraction math client-side.
        void qc.invalidateQueries({ queryKey: queryKeys.orgs });
      } else if (evt.type === "channel.muted") {
        patchChannel(qc, evt.channel_id, (c) => ({ ...c, muted: evt.data.muted }));
      } else if (evt.type === "channel.pinned") {
        patchChannel(qc, evt.channel_id, (c) => ({ ...c, pinned: evt.data.pinned }));
      } else if (evt.type === "channel.added") {
        // Splice into the matching org's cache (or no-op if not loaded
        // yet). Re-fetch in the background to pick up viewer-specific
        // bits the event payload can't carry (e.g. unread count, mute
        // state for a pre-existing channel the user was just added to).
        const incoming = evt.data;
        qc.setQueriesData<ChannelsCache>(
          { queryKey: queryKeys.mm.channelsAll },
          (prev) => {
            if (!prev) return prev;
            if (prev.channels.some((c) => c.channel_id === incoming.channel_id)) return prev;
            const next = [incoming, ...prev.channels];
            next.sort((a, b) => {
              const ta = a.last_message_at ?? a.created_at;
              const tb = b.last_message_at ?? b.created_at;
              return ta < tb ? 1 : ta > tb ? -1 : 0;
            });
            return { channels: next, total: prev.total + 1 };
          },
        );
        void qc.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      } else if (evt.type === "channel.removed") {
        qc.setQueriesData<ChannelsCache>(
          { queryKey: queryKeys.mm.channelsAll },
          (prev) => {
            if (!prev) return prev;
            const next = prev.channels.filter((c) => c.channel_id !== evt.channel_id);
            if (next.length === prev.channels.length) return prev;
            return { channels: next, total: prev.total - 1 };
          },
        );
        if (evt.channel_id === activeChannelIdRef.current) onChannelRemovedRef.current?.(evt.channel_id);
      } else if (evt.type === "org.added") {
        // Splice the new org into the switcher cache. Idempotent: the
        // creator's own tab will already have the org via the create-org
        // mutation's onSuccess; we merge the SSE payload to refresh the
        // activity counters in that case. For invited users / WorkOS
        // reconcile, the org is brand-new to the cache and we append.
        const incoming = evt.data;
        qc.setQueryData<OrgsCache>(queryKeys.orgs, (prev) => {
          if (!prev) return prev;
          const idx = prev.organizations.findIndex((o) => o.org_id === incoming.org_id);
          if (idx >= 0) {
            const next = prev.organizations.slice();
            next[idx] = { ...next[idx], ...incoming };
            return { ...prev, organizations: next };
          }
          return {
            ...prev,
            organizations: [...prev.organizations, incoming],
            total: prev.total + 1,
          };
        });
      } else if (evt.type === "org.updated") {
        // An org the user already has changed under them — today that's a
        // role change, where ``my_role`` is rendered server-side from this
        // recipient's perspective. Merge only: unlike ``org.added`` we never
        // append, so this can't hand someone an org they aren't in.
        const incoming = evt.data;
        qc.setQueryData<OrgsCache>(queryKeys.orgs, (prev) => {
          if (!prev) return prev;
          const idx = prev.organizations.findIndex((o) => o.org_id === incoming.org_id);
          if (idx < 0) return prev;
          const next = prev.organizations.slice();
          next[idx] = { ...next[idx], ...incoming };
          return { ...prev, organizations: next };
        });
        // The members list carries roles too — refetch it for whoever has
        // the Members page open.
        void qc.invalidateQueries({ queryKey: queryKeys.orgMembers(incoming.org_id) });
      } else if (evt.type === "user.status") {
        // Cross-tab sync of the current user's own status, and a feed
        // of presence changes for anyone the user shares a channel
        // with (server fans out to each member's per-user topic).
        presenceRef.current.set(
          evt.data.human_id,
          evt.data.status,
          evt.data.last_seen_at,
          evt.data.last_seen_label ?? null,
        );
      } else if (evt.type === "agent.status") {
        // An agent the user shares a channel with came online (server fans
        // the available-transition out to each member's per-user topic).
        // Offline is time-derived client-side, so we only receive positives.
        agentPresenceRef.current.set(evt.data.agent_id, evt.data.last_alive_at);
      } else if (evt.type === "server.hello") {
        // A deploy restarts the server, drops every open stream, and the
        // clients reconnect — so this frame reaches each tab on the next
        // deploy for free, no polling. If the running server's version
        // differs from the one baked into this bundle, the tab is stale:
        // prompt a reload. A fresh page load always matches (nginx serves
        // index.html no-cache with immutable hashed assets), so this only
        // fires for a tab held open across a deploy.
        const serverVer = evt.data.version;
        if (
          // Web only: a page reload pulls the new bundle. The desktop app
          // ships its own native binary and updates via Tauri's updater, so
          // a reload here wouldn't fetch a new build — the prompt is both
          // wrong and useless inside the desktop app.
          !isDesktop &&
          serverVer &&
          serverVer !== __BUILD_VERSION__ &&
          serverVer !== promptedVersionRef.current
        ) {
          promptedVersionRef.current = serverVer;
          toast("A new version is available", {
            // Stable id so a stray re-fire can only ever replace this toast,
            // never stack a second copy.
            id: "app-update",
            description: "Refresh to load the latest update.",
            duration: Infinity,
            action: {
              label: "Refresh",
              onClick: () => window.location.reload(),
            },
          });
        }
      }
    }, {
      onOpen: () => {
        // RE-connect is the moment to reconcile: the per-user stream carries
        // no initial snapshot and Redis pub/sub has no replay, so anything
        // fanned out to this user while the stream was down is gone.
        // Refetching the sidebar channel lists and the org switcher lets a
        // dropped/restarted stream self-heal instead of leaving the sidebar
        // stale until a manual reload.
        //
        // The FIRST open is the exception, and skipping it matters: the
        // stream comes up a beat after the shell mounts and issues its own
        // fetch, so reconciling here used to run both lists a second time
        // before the first pair had even painted — the two heaviest queries
        // in the read path, doubled, at the exact moment the user is waiting
        // on them. There is nothing to heal on a connection that has never
        // dropped.
        if (firstOpenRef.current) {
          firstOpenRef.current = false;
          return;
        }
        void qc.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
        void qc.invalidateQueries({ queryKey: queryKeys.orgs });
      },
    });

    return () => { conn.close(); };
    // The handler reads currentUserId / activeChannelId through refs, so the
    // stream stays open for the whole session instead of reconnecting on
    // every channel switch (which dropped events during the reconnect gap).
  }, [enabled, qc]);
}

/** Sum of unread across non-muted channels. For the tab title counter. */
export function totalUnreadFromChannels(channels: MmChannel[]): number {
  return channels.reduce(
    (sum, c) => (c.muted ? sum : sum + (c.unread_count ?? 0)),
    0,
  );
}

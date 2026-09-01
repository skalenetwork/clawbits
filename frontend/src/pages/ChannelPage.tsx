import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AttachmentIcon,
  Delete02Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";

import type { ChannelOutletContext } from "@/layouts/AppShell";
import { useAuth } from "../context/AuthContext";
import {
  deleteMmChannelPost,
  getMmChannel,
  listDiscoverableMmChannels,
  listMmChannelEvents,
  listMmChannelPosts,
  listMmChannelMembers,
  listMmChannels,
  listPinnedMmPosts,
  createMmChannelPost,
  editMmChannelPost,
  markMmChannelRead,
  pinMmPost,
  toggleMmPostReaction,
  unpinMmPost,
  type MmChannel,
  type MmChannelMember,
  type MmChannelPost,
  type MmFile,
} from "../lib/api";
import { queryKeys } from "../lib/queryKeys";
import { formatChannelTitle } from "../lib/formatting";
import { draftStore } from "@/lib/messageDrafts";
import { isDesktop, trackRecentChannel } from "@/lib/desktop";
import { useIsMobile } from "@/hooks/use-mobile";
import { errMsg, toast } from "@/lib/toast";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChannelDropOverlay } from "@/components/ChannelDropOverlay";
import { ChannelGlyph } from "@/components/ChannelGlyph";
import { type MessageMentions } from "@/components/MessageMarkdown";
import { UnreadDivider } from "@/components/UnreadDivider";
import { useChannelAttachments } from "@/hooks/useChannelAttachments";
import { useChannelHistory } from "@/hooks/useChannelHistory";
import { useChannelDragDrop } from "@/hooks/useChannelDragDrop";
import { MessageComposer } from "@/components/MessageComposer";
import type { ChannelItem, MentionItem } from "@/components/composer/popovers";
import { PageHeader } from "@/components/PageHeader";
import { ProfileMenuProvider } from "@/components/ProfileMenu";
import { useChannelEvents } from "@/hooks/useChannelEvents";
import { computePendingAutoMention } from "@/lib/autoMention";
import { HERE_TOKEN } from "@/lib/mentions";
import { MessageList, type MessageListHandle } from "@/components/chat/MessageList";
import { ProgressiveBlur } from "@/components/ProgressiveBlur";
import { useChannelPresence } from "@/hooks/useChannelPresence";
import { useGeneratingWord } from "@/hooks/useGeneratingWord";
import { extractShortcodeQuery } from "@/lib/emoji";
import { search as searchEmojis } from "node-emoji";

import {
  extractChannelQuery,
  extractMentionQuery,
  mentionHandle,
  mentionLabel,
  posterName,
} from "@/lib/messageHelpers";
import {
  buildTimeline,
  decorateRows,
  generatingAgentsOf,
  postsOf,
  queuedOwnPostIdsOf,
} from "@/lib/channelTimeline";
import { DaySeparator, MessageSkeletons } from "@/components/chat/dividers";
import { DmPillStatus, PinnedPill } from "@/components/chat/ChannelHeaderPills";
import { MessageRow } from "@/components/chat/MessageRow";
import { GeneratingRow } from "@/components/chat/GeneratingRow";
import { SystemMessage } from "@/components/chat/SystemMessage";

// Posts poll cadence (the safety net behind SSE). A quiet channel polls
// slowly; while any reply is mid-stream we poll fast so a dropped finalize
// event can't strand a message on the loading shimmer for more than a few
// seconds. ETag / If-None-Match keeps a no-change poll to a ~32-byte 304,
// so the fast cadence is nearly free.
const POSTS_POLL_IDLE_MS = 30_000;
const POSTS_POLL_STREAMING_MS = 4_000;

// After the user sends a message to an agent, poll fast for this long. An
// IronClaw reply is a single ``published`` post — one ``post.created`` event
// with no streaming follow-ups — so a dropped event has nothing to self-heal
// against and the idle cadence would leave the reply invisible for up to 30s
// (the "reply needs a page reload" symptom). This client-local window is
// immune to bus/SSE drops and self-limits: the reply lands, or it expires.
const POSTS_POLL_RECENT_SEND_MS = 60_000;

// How long an empty ``streaming`` post (an agent's reply placeholder) may sit
// before the timeline stops rendering it. Covers agents that died mid-reply

/** Route entry. Everything below the guard needs a channel id, so the view is
 *  a separate component rather than a page threading an optional one. */
export default function ChannelPage() {
  const { channelId } = useParams<{ channelId: string }>();
  if (!channelId) {
    return <p className="py-12 text-center text-sm text-muted-foreground">No channel selected</p>;
  }
  return <ChannelView channelId={channelId} />;
}

function ChannelView({ channelId }: { channelId: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  // Mobile vs desktop differ only in chrome details now (both use an inner-scroll
  // Virtualizer + absolute composer; mobile lives in a fixed-viewport shell).
  // Gated on useIsMobile() (NOT isDesktop — a desktop-web browser is !isMobile).
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  // Channel layout exposes the chat-info panel state so the in-header
  // Members pill can act as the toggle (default-closed sidebar).
  const outletCtx = useOutletContext<ChannelOutletContext | undefined>();
  const chatInfoOpen = outletCtx?.chatInfoOpen ?? false;
  const toggleChatInfo = outletCtx?.toggleChatInfo;
  const attachmentsOpen = outletCtx?.attachmentsOpen ?? false;
  const toggleAttachments = outletCtx?.toggleAttachments;
  const [draft, setDraft] = useState("");
  const [caretPos, setCaretPos] = useState(0);
  // Which channel the composer state (draft/reply/target) currently belongs
  // to. Lags ``channelId`` by one commit on switch — ``null`` until the first
  // hydration — so the persist effect below can never write one channel's
  // half-typed draft under the next channel's key (or clobber a stored draft
  // with the initial empty state on mount).
  const [draftChannelId, setDraftChannelId] = useState<string | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [activeEmojiIndex, setActiveEmojiIndex] = useState(0);
  const [emojiDismissed, setEmojiDismissed] = useState(false);
  const [activeChannelIndex, setActiveChannelIndex] = useState(0);
  const [channelDismissed, setChannelDismissed] = useState(false);
  const [replyingTo, setReplyingTo] = useState<MmChannelPost | null>(null);
  // Manual override for the agent-target chip. When set, takes precedence
  // over ``autoMention`` for the next send. Cleared on channel switch or
  // after a successful send.
  const [manualTargetedAgent, setManualTargetedAgent] = useState<string | null>(null);
  // Timestamp (ms) until which the posts query polls at the fast cadence —
  // armed when the user sends to an agent (see POSTS_POLL_RECENT_SEND_MS).
  // State, not a ref, so arming it re-renders and React Query reschedules the
  // refetch timer immediately rather than waiting out the current idle tick.
  const [fastPollUntil, setFastPollUntil] = useState(0);
  const [editingPostId, setEditingPostId] = useState<number | null>(null);
  // Post pending delete confirmation (styled dialog instead of window.confirm).
  const [postIdToDelete, setPostIdToDelete] = useState<number | null>(null);
  const [highlightedPostId, setHighlightedPostId] = useState<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  // Deep-link target (``?msg=<post_id>``): the post we still need to scroll
  // to once it's loaded into the rendered window. Set by the deep-link jump,
  // cleared by the reactive scroll effect when the row appears.
  const pendingJumpRef = useRef<number | null>(null);
  // Single scroll authority. The MessageList component owns the
  // scroll element, the virtualizer, and stick-to-bottom logic; we
  // hold a ref for imperative triggers (send → jump-to-bottom, image
  // load → re-pin when at bottom, jump-to-message popover, etc.) and
  // a state mirror of "at bottom" for the composer's jump-to-latest
  // pill. The ref's ``getIsAtBottom()`` reads the canonical value
  // from inside the list synchronously.
  const messageListRef = useRef<MessageListHandle | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerWrapRef = useRef<HTMLDivElement | null>(null);
  // Track the composer's actual rendered height so the scroll container's
  // bottom padding can match. With attachment chips the composer grows
  // upward, and a fixed ``pb-28`` would let the last message slip behind
  // it. Default = the previous static value (7rem) until ResizeObserver
  // fires for the first time.
  const [composerHeight, setComposerHeight] = useState<number>(112);

  // Composer attachments — owns the per-file upload pipeline (request URL,
  // PUT to R2, confirm). The chip list above the textarea is driven by
  // ``attachments``; ``uploadedFileIds`` is what gets sent with the post.
  const composerAttachments = useChannelAttachments({ channelId });

  // Drag-and-drop into the channel viewport. Window-level listeners pick
  // up file drags anywhere on the page (matches Discord's behaviour);
  // ``ChannelDropOverlay`` provides the visual affordance while a drag
  // is in flight. After files land, pull focus back to the textarea so the
  // user can keep typing.
  const { isDragging } = useChannelDragDrop({
    onDrop: (files) => {
      composerAttachments.addFiles(files);
      requestAnimationFrame(() => { inputRef.current?.focus(); });
    },
  });

  // Keep the scroll container's bottom padding in sync with the
  // composer's actual rendered height. Re-measure on any state change
  // that affects composer layout: attachment chips appearing/leaving,
  // reply quote opening, multi-line draft expansion. Falls through to a
  // ``ResizeObserver`` for window-resize and any other unforeseen change.
  const remeasureComposer = useCallback(() => {
    const el = composerWrapRef.current;
    if (!el) return;
    // ``composerHeight`` must equal the wrapper's *top* offset from the column
    // bottom so the message list reserves exactly the right bottom padding. The
    // measured border-box height already includes the wrapper's own padding, so
    // we add only its bottom *offset* from the edge: 0 on mobile (the wrapper is
    // ``absolute bottom-0``) vs 6px on desktop (``bottom-1.5``). The visible
    // breathing room is owned by ``MessageList``'s ``COMPOSER_BREATHING_ROOM_PX``.
    const bottomOffsetPx = isMobile ? 0 : 6;
    const h = Math.ceil(el.getBoundingClientRect().height) + bottomOffsetPx;
    setComposerHeight(h);
    // Re-pin if the user was at the bottom when the composer grew (attachments,
    // reply quote, multi-line draft). DESKTOP ONLY: on mobile, MessageList's
    // visualViewport-resize listener is the single owner of keyboard re-pin, so
    // re-pinning here too would double-fire during the keyboard animation.
    if (!isMobile && messageListRef.current?.getIsAtBottom()) {
      messageListRef.current.scrollToBottom("auto");
    }
  }, [isMobile]);

  useLayoutEffect(() => {
    remeasureComposer();
  }, [
    remeasureComposer,
    composerAttachments.attachments.length,
    replyingTo,
    draft,
  ]);

  useEffect(() => {
    const el = composerWrapRef.current;
    if (!el) return;
    // Observe the BORDER box, not the default content box: the composer's
    // safe-area bottom padding toggles when the keyboard opens/closes (iOS
    // zeroes the home-indicator inset under the keyboard), and a padding-only
    // change doesn't move the content box — so a content-box observer would
    // miss it and the message list's bottom padding would go stale.
    const obs = new ResizeObserver(() => { remeasureComposer(); });
    obs.observe(el, { box: "border-box" });
    return () => { obs.disconnect(); };
  }, [remeasureComposer, channelId]);

  const channelQuery = useQuery({
    queryKey: queryKeys.mm.channel(channelId),
    queryFn: () => getMmChannel(channelId),
  });

  // Push the channel onto the Window → Recent submenu on every load.
  // No-op on web; the helper itself dedupes and caps the list.
  useEffect(() => {
    const data = channelQuery.data;
    if (!data) return;
    trackRecentChannel({
      id: channelId,
      name: formatChannelTitle(
        data.display_name ?? data.name,
        data.channel_type === "direct" ? "Direct message" : "Channel",
      ),
      path: `/channels/${channelId}`,
    });
  }, [channelId, channelQuery.data]);

  const postsQuery = useQuery({
    queryKey: queryKeys.mm.channelPosts(channelId, 50, 0),
    queryFn: () => listMmChannelPosts(channelId, 50, 0),
    // SSE is the fast path; this poll is the safety net for missed events
    // (dropped finalize, draft approvals, reconnect gaps). The cadence is
    // adaptive: fast while any reply is streaming so a lost finalize event
    // self-heals in seconds, slow when the channel is quiet. With
    // If-None-Match a no-change poll costs ~32 bytes of 304 header.
    // refetchOnWindowFocus catches up instantly when returning to a
    // backgrounded window instead of waiting out the interval.
    refetchInterval: (query) => {
      const anyStreaming =
        query.state.data?.posts.some((p) => p.status === "streaming") ?? false;
      // A recent send to an agent keeps the fast cadence even though an
      // IronClaw reply never enters the ``streaming`` state.
      const recentlySent = Date.now() < fastPollUntil;
      return anyStreaming || recentlySent
        ? POSTS_POLL_STREAMING_MS
        : POSTS_POLL_IDLE_MS;
    },
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  // Inline channel events (member.added / member.removed today). Lives
  // in a parallel query — merged with posts at render time. SSE keeps
  // it live via the ``channel.event`` handler in ``useChannelEvents``;
  // no polling because event volume is low and a missed event only
  // delays a roster-change announcement, not message visibility.
  const latestPosts = postsQuery.data?.posts ?? [];
  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollToBottom("auto");
  }, []);
  const history = useChannelHistory({
    channelId,
    latestPosts,
    refetchPosts: () => { void postsQuery.refetch(); },
    scrollToBottom,
  });

  const eventsQuery = useQuery({
    queryKey: queryKeys.mm.channelEvents(channelId, 100),
    queryFn: () => listMmChannelEvents(channelId, 100),
  });

  const membersQuery = useQuery({
    queryKey: queryKeys.mm.channelMembers(channelId),
    queryFn: () => listMmChannelMembers(channelId),
  });

  // Channel org id — drives the ``#channel`` autocomplete pools below.
  const channelOrgId = channelQuery.data?.org_id ?? null;

  // ``#channel`` autocomplete pool. Joined channels come from the
  // sidebar's existing query (cached and shared); discoverable channels
  // surface public org channels the viewer hasn't joined yet so they
  // can still mention them (link will offer to join on click). Both
  // exclude DMs server-side, so the merged list is "every channel a
  // human can humanly refer to."
  const joinedChannelsQuery = useQuery({
    queryKey: queryKeys.mm.channels(channelOrgId),
    queryFn: () => listMmChannels(channelOrgId),
    enabled: Boolean(channelOrgId),
    staleTime: 30_000,
  });
  const discoverableChannelsQuery = useQuery({
    queryKey: queryKeys.mm.discoverableChannels(channelOrgId),
    queryFn: () => listDiscoverableMmChannels(channelOrgId ?? ""),
    enabled: Boolean(channelOrgId),
    staleTime: 60_000,
  });

  // Pinned-message list — drives both the header pill (count + visibility)
  // and the popover contents. Cached for a short window so toggling the
  // popover stays snappy without a fresh request each time.
  const pinnedQuery = useQuery({
    queryKey: queryKeys.mm.channelPinnedPosts(channelId),
    queryFn: () => listPinnedMmPosts(channelId),
    staleTime: 30_000,
  });

  const mentionMatch = useMemo(
    () => extractMentionQuery(draft, caretPos),
    [draft, caretPos],
  );
  const mentionOptions = useMemo(() => {
    // Scope the @ popover to people actually in this channel — agents and
    // humans who are channel members. We deliberately do NOT surface every
    // org agent here; the popover mirrors the channel roster so you can only
    // mention someone who is present.
    const members = membersQuery.data?.members ?? [];
    const seen = new Set<string>();
    const q = mentionMatch?.query.trim().toLowerCase() ?? "";
    const memberItems = members
      // Don't offer agents the viewer may not tag — contact is closed by
      // default and the server would reject the mention. ``can_tag == null``
      // (not computed) is treated as allowed for back-compat.
      .filter((member) => !(member.agent_id && member.can_tag === false))
      .map((member): MentionItem => ({
        key: `${member.agent_id ?? ""}:${member.human_id ?? ""}`,
        label: mentionLabel(member),
        handle: mentionHandle(member),
        member,
      }))
      .filter((item) => {
        if (!item.handle) return false;
        if (seen.has(item.handle)) return false;
        seen.add(item.handle);
        if (!q) return true;
        return item.handle.toLowerCase().includes(q) || item.label.toLowerCase().includes(q);
      });
    // ``@here`` broadcast — offered in group/public channels only (a DM is
    // already "everyone"), pinned to the top, and shown while its handle is
    // still being typed (``@``, ``@h`` … ``@here``).
    const offerHere =
      channelQuery.data?.channel_type !== "direct" &&
      (q === "" || HERE_TOKEN.startsWith(q));
    const hereItem: MentionItem = {
      key: "__here__",
      label: "here",
      handle: HERE_TOKEN,
      special: "here",
    };
    return (offerHere ? [hereItem, ...memberItems] : memberItems).slice(0, 8);
  }, [membersQuery.data?.members, mentionMatch?.query, channelQuery.data?.channel_type]);
  const mentionOpen = Boolean(!mentionDismissed && mentionMatch && mentionOptions.length > 0);

  // ``#channel`` autocomplete pool. Joined channels come first (the user's
  // own context) followed by discoverable public channels. DMs are filtered
  // out — they don't have a referenceable handle. Membership state is
  // captured per-row so the popover can hint "Join to view" and the
  // renderer can fork the click between Link and Dialog.
  const channelMatch = useMemo(
    () => extractChannelQuery(draft, caretPos),
    [draft, caretPos],
  );
  const joinedChannels = joinedChannelsQuery.data?.channels ?? [];
  const discoverableChannels = discoverableChannelsQuery.data?.channels ?? [];
  const currentUserChannelIds = useMemo(() => {
    const out = new Set<string>();
    for (const c of joinedChannels) out.add(c.channel_id);
    return out;
  }, [joinedChannels]);
  const channelOptions = useMemo<ChannelItem[]>(() => {
    const referenceable: MmChannel[] = [];
    for (const c of joinedChannels) {
      if (c.channel_type === "direct") continue;
      referenceable.push(c);
    }
    // Discoverable rows are ``MmDiscoverableChannel`` — same shape modulo
    // the fields we surface in the popover. Cast to ``MmChannel`` for
    // uniform downstream handling; the missing fields are not read.
    for (const c of discoverableChannels) {
      if (c.channel_type === "direct") continue;
      referenceable.push(c);
    }
    const seen = new Set<string>();
    const q = channelMatch?.query.trim().toLowerCase() ?? "";
    return referenceable
      .filter((c) => {
        if (seen.has(c.channel_id)) return false;
        seen.add(c.channel_id);
        if (!q) return true;
        const name = (c.display_name ?? c.name).toLowerCase();
        return c.name.toLowerCase().includes(q) || name.includes(q);
      })
      .slice(0, 8)
      .map((c) => ({
        key: c.channel_id,
        token: c.name.toLowerCase(),
        channel: c,
        isMember: currentUserChannelIds.has(c.channel_id),
      }));
  }, [joinedChannels, discoverableChannels, channelMatch?.query, currentUserChannelIds]);
  const channelOpen = Boolean(!channelDismissed && channelMatch && channelOptions.length > 0);

  // ``:shortcode`` autocomplete — Discord/Slack style. Mirrors the mention
  // scaffold above so all the keyboard plumbing stays uniform.
  const emojiMatch = useMemo(
    () => extractShortcodeQuery(draft, caretPos),
    [draft, caretPos],
  );
  const emojiOptions = useMemo(() => {
    const q = emojiMatch?.query.trim().toLowerCase() ?? "";
    if (!q) return [];
    return searchEmojis(q).slice(0, 8);
  }, [emojiMatch?.query]);
  const emojiOpen = Boolean(!emojiDismissed && emojiMatch && emojiOptions.length > 0);

  // Live events + self-presence heartbeats.
  const {
    presence,
    activity,
    toolTimelines,
    thinkingTimelines,
    finishedToolTraces,
    finishedThinkingTraces,
    optimisticAgents,
    markAgentGenerating,
  } = useChannelEvents(channelId);
  const { signalTyping } = useChannelPresence(channelId);
  // Rotating gerund shown next to any member in the "generating" state.
  const generatingWord = useGeneratingWord();

  // Capture the channel's unread_count at entry time so the "N new
  // messages" divider can be anchored to the boundary between read and
  // unread posts. Sourced from the sidebar's listMmChannels cache.
  // Frozen on channel switch: the auto-mark-read effect below will
  // zero out the cached count seconds later, but this state stays put
  // so the divider doesn't disappear while the user is reading.
  const [enteredAtUnread, setEnteredAtUnread] = useState<number>(0);
  // ID of the first unread post at channel-entry time. We lock this on
  // first render that has both a non-zero count and a populated post
  // list, then anchor the divider to this specific post for the rest
  // of the session. Without it, a count-based position would drift
  // down each time the user sent a message (own posts shouldn't count
  // as "new" — see backend ``unread_count`` filter).
  const [firstUnreadPostId, setFirstUnreadPostId] = useState<number | null>(null);
  useLayoutEffect(() => {
    setFirstUnreadPostId(null);
    const all = queryClient.getQueriesData<{ channels: MmChannel[]; total: number }>({
      queryKey: queryKeys.mm.channelsAll,
    });
    let count = 0;
    for (const [, data] of all) {
      const ch = data?.channels.find((c) => c.channel_id === channelId);
      if (ch) {
        count = ch.unread_count ?? 0;
        break;
      }
    }
    setEnteredAtUnread(count);
  }, [channelId, queryClient]);

  // Auto-mark-read: whenever the latest visible published post id moves
  // forward and the tab is visible, advance the server-side read pointer
  // for this channel. Server publishes ``channel.read`` on the user's
  // global stream, which clears the sidebar badge across all tabs.
  const latestPostId = useMemo(() => {
    const posts = postsQuery.data?.posts ?? [];
    let max = 0;
    for (const p of posts) {
      if (p.status !== "published") continue;
      if (p.post_id > max) max = p.post_id;
    }
    return max;
  }, [postsQuery.data?.posts]);

  const lastMarkedRef = useRef<number>(0);
  useEffect(() => {
    if (latestPostId <= 0) return;
    if (latestPostId <= lastMarkedRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const targetId = latestPostId;
    lastMarkedRef.current = targetId;
    // Clear the badge for the current tab immediately; cross-tab clears
    // arrive via the channel.read SSE event the server publishes.
    queryClient.setQueriesData<{ channels: MmChannel[]; total: number }>(
      { queryKey: queryKeys.mm.channelsAll },
      (prev) => {
        if (!prev) return prev;
        const idx = prev.channels.findIndex((c) => c.channel_id === channelId);
        if (idx < 0) return prev;
        const channel = prev.channels[idx];
        if (!channel) return prev;
        const next = prev.channels.slice();
        next[idx] = { ...channel, unread_count: 0 };
        return { ...prev, channels: next };
      },
    );
    void markMmChannelRead(channelId, targetId).catch(() => {
      // On failure, allow a retry on the next change.
      lastMarkedRef.current = 0;
    });
  }, [channelId, latestPostId, queryClient]);

  // Re-mark when the tab regains visibility, in case posts arrived while hidden.
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState !== "visible") return;
      if (latestPostId <= 0) return;
      if (latestPostId <= lastMarkedRef.current) return;
      lastMarkedRef.current = latestPostId;
      void markMmChannelRead(channelId, latestPostId).catch(() => {
        lastMarkedRef.current = 0;
      });
    };
    document.addEventListener("visibilitychange", handler);
    return () => { document.removeEventListener("visibilitychange", handler); };
  }, [channelId, latestPostId]);

  // Reset the "highest marked" pointer when the channel changes.
  useEffect(() => {
    lastMarkedRef.current = 0;
  }, [channelId]);

  // Optimistic send: when the user hits Enter, drop a synthetic post
  // into the channel cache *before* the network round-trip, then
  // reconcile against the server's canonical row via ``client_msg_uuid``.
  // The sender sees their message at the bottom in <16 ms (typed → next
  // frame), and the "Sending" check tick lights up while the request is
  // in flight (``post_id < 0`` is the receipt-state trigger). Race
  // between HTTP response and SSE ``post.created`` is resolved by
  // matching on the UUID first, the post_id second.
  const sendMutation = useMutation({
    mutationFn: (vars: {
      message: string;
      parentPostId: number | null;
      fileIds: string[];
      clientMsgUuid: string;
      filesSnapshot: MmFile[];
      targetAgentId: string | null;
    }) =>
      createMmChannelPost(
        channelId,
        vars.message,
        vars.parentPostId,
        vars.fileIds.length ? vars.fileIds : undefined,
        vars.clientMsgUuid,
      ),
    onMutate: (vars) => {
      // Eager UI cleanup so the next keystroke types into an empty
      // composer. Rollback in ``onError`` puts the draft back if the
      // request failed before the user typed anything new.
      const draftBefore = draft;
      const replyBefore = replyingTo;
      const targetBefore = manualTargetedAgent;
      setDraft("");
      setReplyingTo(null);
      setManualTargetedAgent(null);
      composerAttachments.clear();

      const key = queryKeys.mm.channelPosts(channelId, 50, 0);
      // Fire-and-forget cancel of any in-flight refetch for this
      // channel's posts. We deliberately do NOT ``await`` this — our
      // ``listMmChannelPosts`` queryFn doesn't honor an abort signal,
      // so React Query's awaited cancellation resolves only after the
      // in-flight fetch fully settles. Awaiting it would stall
      // ``onMutate`` (and therefore ``mutationFn``) until that
      // unrelated GET completed, which on a slow/hung connection
      // looked exactly like the mutation itself was hanging. The
      // synchronous abort-signal still does its job: any cache write
      // from the in-flight fetch lands tagged as cancelled and
      // React Query discards it, so our optimistic write below isn't
      // overwritten.
      void queryClient.cancelQueries({ queryKey: key });

      // Synthetic post. Negative ``post_id`` keeps it disjoint from
      // server ids (which start at 1) and trips the receipt-state
      // logic into rendering the "Sending" clock. Parent preview is
      // reconstructed from the replied-to post so the optimistic row
      // looks identical to the eventual real one.
      const optimistic: MmChannelPost = {
        post_id: -Date.now(),
        channel_id: channelId,
        agent_id: null,
        human_id: user?.id ?? null,
        poster_display_name: user?.display_name ?? null,
        // Carry the sender's own avatar onto the optimistic row so it paints
        // immediately. The URL is stable + immutable + already in the browser
        // HTTP cache (it's shown in the header, member list, and the sender's
        // own prior messages), so it renders with no network fetch and no
        // flicker, AND it matches the URL the canonical post carries — so the
        // optimistic→canonical swap is a no-op for the <img>. Without this the
        // row showed the initial-letter fallback until the server round-trip
        // landed: the "avatar loads a beat late" symptom.
        avatar: user?.avatar ?? null,
        message: vars.message,
        created_at: new Date().toISOString(),
        status: "published",
        updated_at: null,
        edited_at: null,
        parent_post_id: vars.parentPostId,
        parent_preview: replyBefore
          ? {
              post_id: replyBefore.post_id,
              agent_id: replyBefore.agent_id,
              human_id: replyBefore.human_id,
              poster_display_name: replyBefore.poster_display_name,
              // Schema field is ``message_excerpt`` — the parent quote
              // block trims this on render so passing the full body
              // here is fine; the canonical row will replace it
              // shortly anyway with the server's pre-truncated copy.
              message_excerpt: replyBefore.message,
              status: replyBefore.status,
              attachment_count: replyBefore.files?.length ?? 0,
            }
          : null,
        // Optimistic posts skip the embedded preview — the server
        // resolves it during the round-trip and the row swaps to the
        // real payload on ``onSuccess`` / SSE. If the user typed a URL
        // the card appears within ~1-2 frames of the response landing.
        link_preview: null,
        reactions: [],
        files: vars.filesSnapshot,
        client_msg_uuid: vars.clientMsgUuid,
      };

      // ``prev`` is undefined on the very first send into a freshly-
      // opened channel — ``postsQuery`` hasn't completed yet (or was
      // just cancelled above). Initialize the cache so the user sees
      // their message land immediately instead of waiting for the
      // round-trip + SSE event.
      queryClient.setQueryData<{
        posts: MmChannelPost[];
        total: number;
        limit: number;
        offset: number;
      }>(key, (prev) => {
        if (!prev) {
          return { posts: [optimistic], total: 1, limit: 50, offset: 0 };
        }
        return { ...prev, posts: [optimistic, ...prev.posts], total: prev.total + 1 };
      });

      // Show the "agent is replying" shimmer immediately when targeting an
      // agent. This seeds a self-expiring ``generating`` presence entry
      // (not a fabricated post), so a non-reply can't strand it — the TTL
      // clears it, and a finished agent post clears it instantly.
      if (vars.targetAgentId) {
        markAgentGenerating(vars.targetAgentId);
        // Poll fast until the agent's reply lands — the safety net for a
        // dropped single-shot ``post.created`` (see POSTS_POLL_RECENT_SEND_MS).
        setFastPollUntil(Date.now() + POSTS_POLL_RECENT_SEND_MS);
      }

      // No explicit ``scrollToBottom`` here — ``MessageList``'s
      // ``rows.length`` effect picks up the new row and snaps to the
      // bottom (with a follow-up rAF pass so the position lands AFTER
      // virtua's ResizeObserver has measured the freshly-mounted
      // optimistic row, not at the underestimated initial position).
      // Calling it here would scroll against the OLD ``rows.length``
      // virtua sees synchronously, which is a no-op visually but
      // wasn't doing anything useful.
      inputRef.current?.focus();
      return { optimistic, draftBefore, replyBefore, targetBefore };
    },
    onSuccess: (created, _vars, ctx) => {
      // Replace the optimistic row with the server's canonical version,
      // matched by ``client_msg_uuid``. If the SSE event already won
      // the race and swapped it, the find returns -1 and we no-op —
      // the cache is already consistent.
      //
      // ``prev`` can still be undefined if the channel was cancelled
      // mid-flight or this is the first cache write into a freshly-
      // opened channel — initialize with the canonical row in that
      // case so the user's message remains visible regardless of which
      // path arrived first.
      const key = queryKeys.mm.channelPosts(channelId, 50, 0);
      queryClient.setQueryData<{
        posts: MmChannelPost[];
        total: number;
        limit: number;
        offset: number;
      }>(key, (prev) => {
        if (!prev) return { posts: [created], total: 1, limit: 50, offset: 0 };
        const targetUuid = created.client_msg_uuid ?? ctx?.optimistic.client_msg_uuid;
        // Drop any optimistic row with the same UUID, AND any prior
        // post.created from SSE that may have already inserted the real
        // row at the same post_id — keeps the dedupe robust regardless
        // of which path arrived first.
        const filtered = prev.posts.filter((p) => {
          const isOurOptimistic = targetUuid && p.client_msg_uuid === targetUuid && p.post_id < 0;
          const isAlreadyReal = p.post_id === created.post_id;
          return !isOurOptimistic && !isAlreadyReal;
        });
        return { ...prev, posts: [created, ...filtered] };
      });
    },
    onError: (err: unknown, _vars, ctx) => {
      // Rollback: remove the optimistic row and restore the draft so
      // the user doesn't lose their text. The "agent is replying" shimmer
      // (if any) self-expires via its presence TTL.
      if (ctx) {
        const key = queryKeys.mm.channelPosts(channelId, 50, 0);
        queryClient.setQueryData<{
          posts: MmChannelPost[];
          total: number;
          limit: number;
          offset: number;
        }>(key, (prev) => {
          if (!prev) return prev;
          const next = prev.posts.filter((p) => p.post_id !== ctx.optimistic.post_id);
          const removed = prev.posts.length - next.length;
          if (removed === 0) return prev;
          return { ...prev, posts: next, total: Math.max(0, prev.total - removed) };
        });
        // Only restore the draft if the user hasn't started typing
        // something new in the meantime — overwriting an in-progress
        // message would be worse than losing the failed one.
        setDraft((current) => current.length > 0 ? current : ctx.draftBefore);
        if (ctx.replyBefore) setReplyingTo(ctx.replyBefore);
        if (ctx.targetBefore) setManualTargetedAgent(ctx.targetBefore);
      }
      toast.error(errMsg(err, "Send failed"));
    },
  });

  /** Rewrite an own message's text. Optimistically swaps the message body
   *  and stamps a provisional ``edited_at`` so the marker appears instantly;
   *  reconciles with the server response (which carries the canonical
   *  ``edited_at`` and is also re-broadcast via SSE). */
  const editMutation = useMutation({
    mutationFn: (vars: { postId: number; message: string }) =>
      editMmChannelPost(vars.postId, vars.message),
    onMutate: async (vars) => {
      const key = queryKeys.mm.channelPosts(channelId, 50, 0);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<{
        posts: MmChannelPost[];
        total: number;
        limit: number;
        offset: number;
      }>(key);
      if (!prev) return { prev };
      const provisionalEditedAt = new Date().toISOString();
      queryClient.setQueryData(key, {
        ...prev,
        posts: prev.posts.map((p) =>
          p.post_id === vars.postId
            ? { ...p, message: vars.message, edited_at: provisionalEditedAt }
            : p,
        ),
      });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(
          queryKeys.mm.channelPosts(channelId, 50, 0),
          ctx.prev,
        );
      }
      toast.error(errMsg(err, "Couldn't save edit"));
    },
    onSuccess: (updated) => {
      setEditingPostId(null);
      queryClient.setQueryData<{
        posts: MmChannelPost[];
        total: number;
        limit: number;
        offset: number;
      }>(
        queryKeys.mm.channelPosts(channelId, 50, 0),
        (cache) => cache ? {
          ...cache,
          posts: cache.posts.map((p) => p.post_id === updated.post_id ? updated : p),
        } : cache,
      );
    },
  });

  /** Hard-delete a post. Optimistically drops the row from the local
   *  cache so the UI updates instantly; the SSE ``post.deleted`` event
   *  then drives every other tab/viewer. Rolls back on error. */
  const deleteMutation = useMutation({
    mutationFn: (postId: number) => deleteMmChannelPost(postId),
    onMutate: async (postId) => {
      const key = queryKeys.mm.channelPosts(channelId, 50, 0);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<{
        posts: MmChannelPost[];
        total: number;
        limit: number;
        offset: number;
      }>(key);
      if (!prev) return { prev };
      queryClient.setQueryData(key, {
        ...prev,
        posts: prev.posts.filter((p) => p.post_id !== postId),
        total: Math.max(0, prev.total - 1),
      });
      return { prev };
    },
    onError: (err, _postId, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(
          queryKeys.mm.channelPosts(channelId, 50, 0),
          ctx.prev,
        );
      }
      toast.error(errMsg(err, "Couldn't delete message"));
    },
  });

  /** Toggle a reaction on a post. Optimistically flips the caller's
   *  participation in the local cache so the pill highlight + count
   *  update instantly, then reconciles with the server response (which
   *  is also re-broadcast via SSE for other viewers). */
  const reactionMutation = useMutation({
    mutationFn: (vars: { postId: number; emoji: string }) =>
      toggleMmPostReaction(vars.postId, vars.emoji),
    onMutate: async (vars) => {
      const key = queryKeys.mm.channelPosts(channelId, 50, 0);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<{
        posts: MmChannelPost[];
        total: number;
        limit: number;
        offset: number;
      }>(key);
      if (!prev || user == null) return { prev };
      const userId = user.id;
      queryClient.setQueryData(key, {
        ...prev,
        posts: prev.posts.map((p) => {
          if (p.post_id !== vars.postId) return p;
          const reactions = p.reactions ?? [];
          const existing = reactions.find((r) => r.emoji === vars.emoji);
          if (existing?.human_ids.includes(userId)) {
            // Remove our reaction (and the whole bucket if we were alone).
            const nextHumans = existing.human_ids.filter((id) => id !== userId);
            const nextCount = existing.count - 1;
            return {
              ...p,
              reactions: nextCount === 0
                ? reactions.filter((r) => r.emoji !== vars.emoji)
                : reactions.map((r) =>
                  r.emoji === vars.emoji
                    ? { ...r, human_ids: nextHumans, count: nextCount }
                    : r,
                ),
            };
          }
          if (existing) {
            // Add our id to the existing bucket.
            return {
              ...p,
              reactions: reactions.map((r) =>
                r.emoji === vars.emoji
                  ? { ...r, human_ids: [...r.human_ids, userId], count: r.count + 1 }
                  : r,
              ),
            };
          }
          // First reactor for this emoji on this post.
          return {
            ...p,
            reactions: [
              ...reactions,
              { emoji: vars.emoji, count: 1, human_ids: [userId], agent_ids: [] },
            ],
          };
        }),
      });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(
          queryKeys.mm.channelPosts(channelId, 50, 0),
          ctx.prev,
        );
      }
      toast.error(errMsg(err, "Couldn't toggle reaction"));
    },
    onSuccess: (updated) => {
      // Server has the canonical view (incl. cross-tab agent reactions);
      // merge it in so we stay consistent if the optimistic path missed
      // anything — e.g. someone else reacted between mutate and ack.
      queryClient.setQueryData<{
        posts: MmChannelPost[];
        total: number;
        limit: number;
        offset: number;
      }>(
        queryKeys.mm.channelPosts(channelId, 50, 0),
        (prev) => prev ? {
          ...prev,
          posts: prev.posts.map((p) => p.post_id === updated.post_id ? updated : p),
        } : prev,
      );
    },
  });

  /** Toggle pin/unpin on a channel post. Optimistically flips ``pinned_at``
   *  in the local cache so the header pill count + per-message glyph
   *  update instantly. The pinned-list popover is invalidated on success
   *  so it refetches the next time it opens. */
  const pinMutation = useMutation({
    mutationFn: (post: MmChannelPost) =>
      post.pinned_at != null
        ? unpinMmPost(post.post_id)
        : pinMmPost(post.post_id),
    onMutate: async (post) => {
      const key = queryKeys.mm.channelPosts(channelId, 50, 0);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<{
        posts: MmChannelPost[];
        total: number;
        limit: number;
        offset: number;
      }>(key);
      if (!prev || user == null) return { prev };
      const willPin = post.pinned_at == null;
      const stamp = willPin ? new Date().toISOString() : null;
      queryClient.setQueryData(key, {
        ...prev,
        posts: prev.posts.map((p) =>
          p.post_id === post.post_id
            ? {
                ...p,
                pinned_at: stamp,
                pinned_by_human_id: willPin ? user.id : null,
              }
            : p,
        ),
      });
      return { prev };
    },
    onError: (err, _post, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(
          queryKeys.mm.channelPosts(channelId, 50, 0),
          ctx.prev,
        );
      }
      toast.error(errMsg(err, "Couldn't update pin"));
    },
    onSuccess: (updated) => {
      // The optimistic update already reflects the new state; this
      // reconciles the server's canonical ``pinned_at`` value (which may
      // differ by milliseconds) and re-syncs against any concurrent
      // changes. The popover list is invalidated so the next open
      // refetches from scratch.
      queryClient.setQueryData<{
        posts: MmChannelPost[];
        total: number;
        limit: number;
        offset: number;
      }>(
        queryKeys.mm.channelPosts(channelId, 50, 0),
        (prev) => prev ? {
          ...prev,
          posts: prev.posts.map((p) => p.post_id === updated.post_id ? updated : p),
        } : prev,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.mm.channelPinnedPosts(channelId),
      });
      toast.success(updated.pinned_at != null ? "Pinned to channel" : "Unpinned");
    },
  });


  useEffect(() => {
    setActiveMentionIndex(0);
    setMentionDismissed(false);
  }, [mentionMatch?.start, mentionMatch?.query, channelId]);

  useEffect(() => {
    setActiveEmojiIndex(0);
    setEmojiDismissed(false);
  }, [emojiMatch?.start, emojiMatch?.query, channelId]);

  useEffect(() => {
    setActiveChannelIndex(0);
    setChannelDismissed(false);
  }, [channelMatch?.start, channelMatch?.query, channelId]);

  const insertMention = (handle: string) => {
    const match = extractMentionQuery(draft, inputRef.current?.selectionStart ?? caretPos);
    if (!match) return;
    const next = `${draft.slice(0, match.start)}@${handle} ${draft.slice(match.end)}`;
    setDraft(next);
    setMentionDismissed(false);
    const nextCaret = match.start + handle.length + 2;
    setCaretPos(nextCaret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  /** Replace an in-progress ``#`` token with the picked channel's canonical
   *  name + trailing space. Mirrors :func:`insertMention`. */
  const insertChannel = (token: string) => {
    const match = extractChannelQuery(draft, inputRef.current?.selectionStart ?? caretPos);
    if (!match) return;
    const next = `${draft.slice(0, match.start)}#${token} ${draft.slice(match.end)}`;
    setDraft(next);
    setChannelDismissed(false);
    const nextCaret = match.start + token.length + 2;
    setCaretPos(nextCaret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  /** Insert ``text`` at the current selection (or append if no caret yet).
   *  Used by the emoji picker button. */
  const insertAtCaret = (text: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? caretPos ?? draft.length;
    const end = el?.selectionEnd ?? start;
    const next = draft.slice(0, start) + text + draft.slice(end);
    setDraft(next);
    const nextCaret = start + text.length;
    setCaretPos(nextCaret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  /** Replace an in-progress ``:shortcode`` with its emoji glyph. */
  const insertEmoji = (emoji: string) => {
    const match = extractShortcodeQuery(draft, inputRef.current?.selectionStart ?? caretPos);
    if (!match) return;
    const next = draft.slice(0, match.start) + emoji + draft.slice(match.end);
    setDraft(next);
    setEmojiDismissed(false);
    const nextCaret = match.start + emoji.length;
    setCaretPos(nextCaret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  useEffect(() => () => {
    if (highlightTimerRef.current != null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    // Leaving the chat surface entirely (e.g. Esc → Home) — persist any
    // pending draft write now rather than waiting for the debounce tick.
    draftStore.flush();
  }, []);

  // Continuously mirror the composer state into the per-channel draft store
  // (Telegram-style local drafts). Writes go to ``draftChannelId`` — the
  // channel the state belongs to — never the route's ``channelId``, and the
  // store only debounces the localStorage write; its in-memory map updates
  // synchronously, so nothing is lost on a fast channel switch. A successful
  // send clears the states below, which deletes the stored draft; the
  // send-error rollback restores them, which re-saves it.
  useEffect(() => {
    const userId = user?.id;
    if (userId == null || draftChannelId == null) return;
    draftStore.set(userId, draftChannelId, {
      text: draft,
      reply: replyingTo,
      targetAgentId: manualTargetedAgent,
    });
  }, [user?.id, draftChannelId, draft, replyingTo, manualTargetedAgent]);

  // Hydrate the composer from the new channel's stored draft (text + caret +
  // reply strip + agent target) on every switch. History pagination resets
  // itself inside ``useChannelHistory``, and the library's pin-to-bottom state
  // is reset by the initial scroll effect below (forced instant scroll to the
  // new channel's bottom).
  useEffect(() => {
    // Force the previous channel's pending draft write out before reading
    // the next channel's — cheap, and makes switches durable checkpoints.
    draftStore.flush();
    const stored =
      user?.id != null ? draftStore.get(user.id, channelId) : null;
    setDraft(stored?.text ?? "");
    setCaretPos(stored?.text.length ?? 0);
    setReplyingTo(stored?.reply ?? null);
    setManualTargetedAgent(stored?.targetAgentId ?? null);
    setDraftChannelId(channelId);
    setEditingPostId(null);
    setHighlightedPostId(null);
    // Drop any in-flight composer attachments — switching channels
    // invalidates them (they were uploaded against the prior channel_id).
    composerAttachments.clear();
    if (highlightTimerRef.current != null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    inputRef.current?.focus();
    if (stored && stored.text.length > 0) {
      // The textarea commits the restored value on the next render; park
      // the caret at the end of the draft once it's there.
      const len = stored.text.length;
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(len, len);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // ------------------------------------------------------------------
  // Type-anywhere → focus the composer. The canonical chat-app pattern
  // (Discord, Slack, Linear, Telegram): any printable keypress that
  // lands outside an input redirects focus to the textarea so the
  // keystroke isn't dropped. Layered with guardrails so we don't steal
  // focus from system shortcuts, modal dialogs, mid-selections, or IME
  // composition.
  // ------------------------------------------------------------------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Already in a text field — let the native event run.
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
        if (t.isContentEditable) return;
      }
      // System / app shortcuts (⌘F, ⌘V, Ctrl+K, etc.).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Non-printable keys: ArrowDown, Tab, Enter, F-keys, Escape, etc.
      // Printable keys have a single-character `key`. Caveat: "Dead"
      // appears for dead-key composition starts (´ ` ¨), which we want
      // to pass through to the textarea — let it fall through.
      if (e.key.length !== 1 && e.key !== "Dead") return;
      // IME composition is mid-flight — never steal.
      if (e.isComposing) return;
      // User is selecting text somewhere — preserve their selection.
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      // A modal/popover with explicit dialog role is open — its focus
      // trap should win. Base-ui popovers don't use role=dialog so the
      // agent chip / cheatsheet won't trigger this guard.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      // Touch-only devices: focusing summons the OS keyboard which is
      // an uninvited surprise. Desktop only.
      if (window.matchMedia?.("(pointer: coarse)").matches) return;

      const ta = inputRef.current;
      if (!ta || document.activeElement === ta) return;
      ta.focus();
      // No preventDefault — the keystroke continues into the now-focused
      // textarea via the browser's normal text-insertion path.
    };
    window.addEventListener("keydown", handler);
    return () => { window.removeEventListener("keydown", handler); };
  }, [channelId]);

  // Esc anywhere in the chat → leave for Home. Skipped when the keystroke
  // was already consumed (the composer's reply/target/popover Esc ladder
  // calls preventDefault), while editing a message (Esc cancels the edit),
  // or while a modal dialog is open (its own focus trap owns Esc).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (editingPostId != null) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      void navigate("/home");
    };
    window.addEventListener("keydown", handler);
    return () => { window.removeEventListener("keydown", handler); };
  }, [channelId, editingPostId, navigate]);

  // Jump to bottom instantly on first render and on every channel
  // switch, once the new channel's posts have rendered. The library's
  // `initial: "instant"` only fires on first ResizeObserver event, but
  // the component doesn't unmount between channels, so we drive
  // channel-switch resets manually here. `ignoreEscapes` overrides any
  // prior "user scrolled up" state from the previous channel.
  // ArrowUp on an empty composer → edit your most recent message (the
  // Slack/Discord quick-edit gesture). Picks the newest published post
  // authored by the current user.
  const editLastOwnMessage = () => {
    if (!user) return;
    const posts = postsQuery.data?.posts ?? [];
    let target: MmChannelPost | null = null;
    for (const p of posts) {
      if (p.human_id === user.id && p.agent_id == null && p.status === "published") {
        if (!target || p.post_id > target.post_id) target = p;
      }
    }
    if (target) setEditingPostId(target.post_id);
  };

  const handleSend = () => {
    // Re-entrancy guard. The Send button is already ``disabled`` while a
    // mutation is in flight, but the textarea ``Enter`` handler bypasses
    // that — without this check, hammering Enter (or a slow network +
    // double keystroke) creates duplicate posts before ``setDraft("")``
    // in ``onSuccess`` has a chance to clear the message.
    if (sendMutation.isPending) return;
    const msg = draft.trim();
    const hasAttachments = composerAttachments.attachments.length > 0;
    // Block empty sends, but allow a file-only post (message blank, ≥1 file).
    if (!msg && !hasAttachments) return;
    if (!composerAttachments.isReadyToSend) {
      // Some uploads are still in flight or failed — Send is disabled in
      // the UI, but defend the guard here too in case the user hits Enter.
      return;
    }
    // Send-time target handle. Manual pick wins; otherwise the implicit
    // auto-mention drives the prefix. The agent chip is the user-facing
    // surface for both states.
    const explicitTargetHandle = manualTargetedAgent ?? autoMention?.handle ?? null;
    const directAgentHandle = channelQuery.data?.channel_type === "direct"
      ? (membersQuery.data?.members.find((m) => m.agent_id != null)?.agent_id ?? null)
      : null;
    const targetHandle = explicitTargetHandle ?? directAgentHandle;
    const prefix = explicitTargetHandle ? `@${explicitTargetHandle}` : null;
    const needsPrefix =
      prefix != null && !msg.toLowerCase().includes(prefix.toLowerCase());
    const messageOut = prefix && needsPrefix && msg
      ? `${prefix} ${msg}`
      : prefix && needsPrefix && !msg
        ? prefix
        : msg;
    const mentionedAgentHandle = membersQuery.data?.members
      .filter((m): m is MmChannelMember & { agent_id: string } => m.agent_id != null)
      .find((m) => messageOut.toLowerCase().includes(`@${mentionHandle(m).toLowerCase()}`))
      ?.agent_id ?? null;
    const placeholderAgentId = targetHandle ?? mentionedAgentHandle;
    // Snapshot the attachment-renderable MmFile shapes from the
    // composer state. The server's canonical reply has presigned URLs;
    // the optimistic row uses the locally-known file_id + filename so
    // the chip layout commits at the right height before the real
    // ``MmFileResponse`` lands. Without a snapshot the row would
    // briefly render as text-only and resize when ``onSuccess`` fires.
    const filesSnapshot: MmFile[] = composerAttachments.attachments
      .filter((a) => a.status === "uploaded" && a.fileId)
      .map((a) => ({
        file_id: a.fileId!,
        channel_id: channelId,
        filename: a.file.name,
        content_type: a.file.type || "application/octet-stream",
        size_bytes: a.file.size,
        status: "uploaded",
        width: null,
        height: null,
        duration_ms: null,
        created_at: new Date().toISOString(),
        uploaded_at: new Date().toISOString(),
        download_url: null,
        thumbnail_url: null,
      }));
    // Sending from an anchored history window snaps back to the live tail so
    // the new message is actually visible — it lands in the live cache, which
    // the anchored view doesn't render.
    if (history.isAnchored) history.returnToPresent();
    sendMutation.mutate({
      message: messageOut,
      parentPostId: replyingTo?.post_id ?? null,
      fileIds: composerAttachments.uploadedFileIds,
      clientMsgUuid: crypto.randomUUID(),
      filesSnapshot,
      targetAgentId: placeholderAgentId,
    });
    // Sending is an explicit "I want to be at the latest" action — force the
    // stick-to-bottom latch on (via scrollToBottom) so the new row + the reply
    // are followed even if the user had scrolled up. The optimistic row is
    // already in the cache from onMutate; MessageList's rows.length effect does
    // the exact pin to the freshly-measured bottom on the next commit.
    messageListRef.current?.scrollToBottom("smooth");
  };

  const startReply = (post: MmChannelPost) => {
    setReplyingTo(post);
    requestAnimationFrame(() => { inputRef.current?.focus(); });
  };

  const cancelReply = () => {
    setReplyingTo(null);
    inputRef.current?.focus();
  };

  const flashPost = (postId: number) => {
    setHighlightedPostId(postId);
    if (highlightTimerRef.current != null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightedPostId(null);
      highlightTimerRef.current = null;
    }, 1500);
  };

  const scrollToPost = (postId: number): boolean => {
    // The virtualizer may not have rendered the target row yet — use
    // its index-based scroll API so it can compute the offset and
    // mount the row on its own. ``align: "center"`` puts the jump
    // target in the middle of the viewport like the old
    // ``scrollIntoView({ block: "center" })`` did.
    const idx = rows.findIndex((r) => r.kind === "post" && r.post.post_id === postId);
    if (idx < 0) return false;
    messageListRef.current?.scrollToIndex(idx, { align: "center", behavior: "smooth" });
    flashPost(postId);
    return true;
  };

  // Unified "jump to a message" — used by pinned messages, reply quotes and
  // search deep links. A rendered target (live tail or an open window) is just
  // centred; anything else re-anchors the timeline around it, and the reactive
  // scroll effect centres + flashes it once those rows render.
  const jumpToPost = async (postId: number): Promise<void> => {
    if (scrollToPost(postId)) return;
    pendingJumpRef.current = postId;
    await history.anchorAround(postId);
  };

  const channel = channelQuery.data;
  const channelEvents = eventsQuery.data?.events ?? [];
  // The render pipeline: the history hook's posts become a timeline, the
  // timeline becomes decorated rows (see lib/channelTimeline).
  const posts = history.posts;
  const ordered = useMemo(() => buildTimeline(posts, channelEvents), [posts, channelEvents]);
  const orderedForUnread = useMemo(() => postsOf(ordered), [ordered]);

  const memberList = membersQuery.data?.members;
  const generatingAgents = useMemo(
    () => generatingAgentsOf(presence, posts, memberList ?? []),
    [presence, posts, memberList],
  );
  const queuedOwnPostIds = useMemo(
    () => queuedOwnPostIdsOf(posts, generatingAgents.length > 0, user?.id),
    [posts, generatingAgents.length, user],
  );

  // Lock the unread anchor on the first render after posts load (only
  // once per channel). After this, the divider stays before the same
  // post id regardless of new messages appearing — so the user's own
  // sent messages stack below the divider's anchor without bumping
  // the divider down to count them as "new". The anchor is computed
  // against ``orderedForUnread`` (posts only) because events don't
  // count toward unread on the server.
  useLayoutEffect(() => {
    if (firstUnreadPostId != null) return;
    if (enteredAtUnread <= 0) return;
    if (orderedForUnread.length === 0) return;
    const idx = Math.max(0, orderedForUnread.length - enteredAtUnread);
    const anchor = orderedForUnread[idx];
    if (anchor) setFirstUnreadPostId(anchor.post_id);
  }, [enteredAtUnread, orderedForUnread, firstUnreadPostId]);

  const rows = useMemo(
    () => decorateRows({
      timeline: ordered,
      enteredAtUnread,
      firstUnreadPostId,
      generatingAgents,
      queuedOwnPostIds,
    }),
    [ordered, enteredAtUnread, firstUnreadPostId, generatingAgents, queuedOwnPostIds],
  );

  // Jump target (pinned message, search deep-link, reply quote): once the
  // pending post is present in the rendered rows — which for an off-screen
  // jump means a whole new anchored window was just swapped in — centre and
  // flash it. Reacts to ``rows`` so it always runs with the freshest list.
  //
  // A re-anchor replaces the entire item array, so virtua hasn't measured the
  // new rows on this commit; a single ``smooth`` scroll-to-index would chase a
  // moving target (estimated heights) and never land. So align *instantly* and
  // re-issue across a few frames as measurements settle — the same two-pass
  // idea the stick-to-bottom effect uses — then flash once it's put.
  useEffect(() => {
    const target = pendingJumpRef.current;
    if (target == null) return;
    const idx = rows.findIndex((r) => r.kind === "post" && r.post.post_id === target);
    if (idx < 0) return;
    pendingJumpRef.current = null;
    const list = messageListRef.current;
    let raf = 0;
    let pass = 0;
    const settle = () => {
      list?.scrollToIndex(idx, { align: "center", behavior: "auto" });
      if (++pass < 4) {
        raf = requestAnimationFrame(settle);
      } else {
        flashPost(target);
      }
    };
    settle();
    return () => { cancelAnimationFrame(raf); };
     
  }, [rows]);

  // Read ``?msg=<post_id>`` and jump to that message once this channel's
  // first page has loaded. Strip the param afterwards so reloads / back-nav
  // don't re-trigger and the URL stays clean. Runs once per (channel, msg).
  const handledMsgRef = useRef<string | null>(null);
  useEffect(() => {
    const raw = searchParams.get("msg");
    if (!raw || !postsQuery.data) return;
    const token = `${channelId}:${raw}`;
    if (handledMsgRef.current === token) return;
    const postId = Number(raw);
    if (!Number.isFinite(postId)) return;
    handledMsgRef.current = token;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("msg");
        return next;
      },
      { replace: true },
    );
    void jumpToPost(postId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, searchParams, postsQuery.data]);

  const channelTitle = formatChannelTitle(
    channel?.display_name ?? channel?.name,
    channel?.channel_type === "direct" ? "Direct message" : "Channel",
  );

  // For a 1:1 DM with an agent, the header avatar + name link to that agent's
  // profile page (same `/agents/:agentId` route the sidebar uses). Only agent
  // DMs are clickable for now — human DMs keep their status pill and group
  // channels stay non-navigable. ``dm_peer_agent_id`` is the agent_id the route
  // resolves by (e.g. "LoomGlow").
  const headerAgentHref =
    channel?.channel_type === "direct" && channel.dm_peer_agent_id
      ? `/agents/${encodeURIComponent(channel.dm_peer_agent_id)}`
      : null;

  // Tokens used to highlight @mentions inside post bodies. Agents are keyed
  // by agent_id (which is also what the inbound poller's mention gate
  // matches on). Humans are keyed under multiple normalisations so all
  // three writing styles resolve to the same member:
  //   - ``mentionHandle`` (what the autocomplete inserts, e.g. ``Stan-Lee``
  //     for "Stan Lee" or ``john.doe`` for "John.Doe")
  //   - whitespace-stripped display name ("@StanLee", "@stanlee")
  //   - synthetic ``user-<id>`` for fallback when display_name is empty
  const mentions = useMemo<MessageMentions>(() => {
    const members = membersQuery.data?.members ?? [];
    const agentTokens = new Set<string>();
    const humanTokens = new Set<string>();
    const memberByToken = new Map<string, typeof members[number]>();
    let primaryAgentToken: string | null = null;
    for (const m of members) {
      if (m.agent_id) {
        const t = m.agent_id.toLowerCase();
        agentTokens.add(t);
        memberByToken.set(t, m);
        // First agent in a channel is treated as the "resident" agent. In
        // owner↔agent DMs there is exactly one; in other channels we just
        // pick the first deterministically and let any others use the
        // softer agent style.
        primaryAgentToken ??= t;
      }
      const addHumanToken = (t: string) => {
        if (!t) return;
        humanTokens.add(t);
        memberByToken.set(t, m);
      };
      if (m.display_name) {
        addHumanToken(m.display_name.toLowerCase().replace(/\s+/g, ""));
      }
      // Canonical handle form (matches what the composer autocomplete
      // inserts). Covers names with spaces ("Stan Lee" → "stan-lee"),
      // dots ("john.doe"), and hyphens already in the name.
      const handle = mentionHandle(m).toLowerCase();
      if (handle && !m.agent_id) addHumanToken(handle);
      if (m.human_id != null) {
        addHumanToken(`user-${String(m.human_id)}`);
      }
    }
    // ``#channel`` lookup. Keyed by ``name.toLowerCase()`` (channel names
    // are slug-shaped already — lowercased, hyphenated). Same combined
    // pool as the autocomplete: joined channels + discoverable public
    // ones in this org. Stable membership set so the renderer can pick
    // Link vs JoinDialog without re-walking the list.
    const channelsByToken = new Map<string, MmChannel>();
    for (const c of joinedChannels) {
      if (c.channel_type === "direct") continue;
      channelsByToken.set(c.name.toLowerCase(), c);
    }
    for (const c of discoverableChannels) {
      if (c.channel_type === "direct") continue;
      const key = c.name.toLowerCase();
      if (channelsByToken.has(key)) continue;
      channelsByToken.set(key, c);
    }

    return {
      agentTokens,
      humanTokens,
      primaryAgentToken,
      memberByToken,
      channelsByToken,
      currentUserChannelIds,
      orgId: channel?.org_id ?? null,
      onMentionInsert: (handle: string) => { insertAtCaret(`@${handle} `); },
      currentUserId: user?.id ?? null,
    };
    // ``insertAtCaret`` closes over draft/caretPos via inputRef + state, so
    // it's safe to capture once per channel-member-list change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    membersQuery.data?.members,
    channel?.org_id,
    user?.id,
    joinedChannels,
    discoverableChannels,
    currentUserChannelIds,
  ]);

  // ------------------------------------------------------------------
  // Auto-mention: keep multi-person channels feeling like 1:1 chat when
  // the user is mid-turn with an agent. The pure decision lives in
  // ``computePendingAutoMention``; we just feed it the live state here
  // and route the result into the chip + send pipeline.
  //
  // Suppressed in direct channels (server-side auto-reply already
  // covers those) and in any channel without an agent member.
  // ------------------------------------------------------------------
  const isDirectChannel = channel?.channel_type === "direct";
  const myMentionTokens = useMemo(() => {
    const out = new Set<string>();
    if (user?.id != null) out.add(`user-${String(user.id)}`);
    const me = membersQuery.data?.members.find((m) => m.human_id === user?.id);
    if (me?.display_name) out.add(me.display_name.toLowerCase().replace(/\s+/g, ""));
    // Also accept the autocompleted handle form (spaces → "-", dots kept),
    // so "agent-to-me" detection fires when an agent writes "@Stan-Lee"
    // rather than just "@StanLee".
    if (me) {
      const handle = mentionHandle(me).toLowerCase();
      if (handle) out.add(handle);
    }
    return out;
  }, [user?.id, membersQuery.data?.members]);

  // Bumped on a 30s tick so the chip auto-expires after the window
  // without requiring a re-render trigger (a quiet channel won't get
  // any other state changes). Cheap — empty channels short-circuit.
  const [autoMentionNow, setAutoMentionNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => { setAutoMentionNow(Date.now()); }, 30_000);
    return () => { window.clearInterval(handle); };
  }, []);

  // Floor for time-based auto-mention triggers: only posts that arrived
  // AFTER I joined this channel count as "active turn" signals. Without
  // this, opening a channel that had a recent agent reply 2 min ago
  // would silently pre-fill the chip even though I'm just catching up
  // on history. Reset whenever the channel changes.
  const [channelEnteredAt, setChannelEnteredAt] = useState<number>(() => Date.now());
  useEffect(() => {
    setChannelEnteredAt(Date.now());
  }, [channelId]);

  const pendingAgentMention = useMemo(
    () => computePendingAutoMention({
      currentUserId: user?.id ?? null,
      isDirectChannel,
      members: membersQuery.data?.members ?? [],
      posts: postsQuery.data?.posts ?? [],
      replyingTo,
      handleFor: mentionHandle,
      labelFor: mentionLabel,
      myMentionTokens,
      nowMs: autoMentionNow,
      windowMs: 5 * 60_000,
      channelEnteredAtMs: channelEnteredAt,
    }),
    [
      user?.id,
      isDirectChannel,
      membersQuery.data?.members,
      postsQuery.data?.posts,
      replyingTo,
      myMentionTokens,
      autoMentionNow,
      channelEnteredAt,
    ],
  );

  // Dismissal is keyed by triggerKey so a NEW trigger (different post
  // id) un-dismisses naturally. Channel switch clears the dismissal.
  const [dismissedAutoMentionKey, setDismissedAutoMentionKey] = useState<string | null>(null);
  useEffect(() => {
    setDismissedAutoMentionKey(null);
  }, [channelId]);

  const autoMention =
    pendingAgentMention && pendingAgentMention.triggerKey !== dismissedAutoMentionKey
      ? pendingAgentMention
      : null;

  const dismissAutoMention = useCallback(() => {
    if (pendingAgentMention) {
      setDismissedAutoMentionKey(pendingAgentMention.triggerKey);
    }
  }, [pendingAgentMention]);

  // Derive "who's typing / generating" entries from presence, excluding
  // self. Display name is all the composer's TypingRow needs; the
  // screen-reader fallback label is composed below from the same list.
  const activityPeople = useMemo(() => {
    const members = membersQuery.data?.members ?? [];
    interface Entry {
      key: string;
      displayName: string;
      status: "typing" | "generating";
    }
    const out: Entry[] = [];
    for (const [key, status] of Object.entries(presence)) {
      const [kind, id] = key.split(":", 2) as ["agent" | "human", string];
      if (kind === "human" && user && String(user.id) === id) continue;  // skip self
      // The bottom activity line only surfaces *human* activity. An
      // agent's work is already visible via the draft shimmer on its
      // own message row, so echoing "Bot is generating…" under the
      // composer would be redundant noise.
      if (kind !== "human") continue;
      if (status !== "typing" && status !== "generating") continue;
      const m = members.find(mm => String(mm.human_id) === id);
      const displayName = m?.display_name ?? `User ${id}`;
      out.push({ key, displayName, status });
    }
    return out;
  }, [presence, membersQuery.data, user]);

  // Screen-reader fallback — the visual pills convey the same info but
  // dot-bounce + avatar doesn't read as a sentence to assistive tech.
  const activityLabel = useMemo(() => {
    const typing = activityPeople.filter(p => p.status === "typing").map(p => p.displayName);
    const generating = activityPeople.filter(p => p.status === "generating").map(p => p.displayName);
    const fmt = (names: string[], suffix: string) => {
      const [first = "", second = ""] = names;
      if (names.length === 0) return null;
      if (names.length === 1) return `${first} is ${suffix}`;
      if (names.length === 2) return `${first} and ${second} are ${suffix}`;
      return `${first}, ${second} and ${names.length - 2} others are ${suffix}`;
    };
    const parts: string[] = [];
    const t = fmt(typing, "typing…");
    const g = fmt(generating, `${generatingWord.toLowerCase()}…`);
    if (t) parts.push(t);
    if (g) parts.push(g);
    return parts.join(" · ");
  }, [activityPeople, generatingWord]);

  // Right-side "chat info" pill: member count for channels, info icon
  // only for DMs. Pressed visual when the details panel is open.
  const members = membersQuery.data?.members ?? [];
  const memberCount = membersQuery.data?.total ?? members.length;

  return (
    <ProfileMenuProvider
      orgId={channel?.org_id ?? null}
      currentUserId={user?.id ?? null}
      onMentionInsert={(handle: string) => { insertAtCaret(`@${handle} `); }}
    >
    <div
      className={
        // Height-bounded on both: the column fills the fixed-viewport shell
        // (mobile) or the content card (desktop) so MessageList's inner scroller
        // gets a real ``viewportSize``. ``min-h-0`` lets it shrink below the
        // natural content height instead of expanding the page.
        `relative isolate flex h-full min-h-0 flex-1 flex-col ${isDesktop ? "pb-2" : ""}`
      }
    >
      {/* Drag-and-drop overlay — pointer-events-none so the window-level
          drag listener still sees ``dragover`` and ``drop`` underneath. */}
      <ChannelDropOverlay show={isDragging} />
      {/* Top fade scrim - a progressive blur (stacked backdrop-filter
          layers, see ProgressiveBlur) plus a background→transparent tint at
          the top edge of the chat column. ``absolute`` (scoped to this
          ``relative isolate`` column) so it stays inside the content card and
          aligned with the message column - not ``fixed``, which used to span
          the whole window and now spills across the rail + contextual sidebar.
          ``-z-10`` parks it behind all content (messages, header pills,
          composer) but above the card background, thanks to the column's
          ``isolate``; pointer-events-none keeps scrolling unobstructed. */}
      {/* Channel header — avatar + name on the left, pins + members on the
          right - portaled into the unified header bar (see PageHeader) so it
          lines up with the sidebar header like every other page. */}
      <PageHeader
        leading={
          channel ? (
            headerAgentHref ? (
              <Link
                to={headerAgentHref}
                viewTransition
                aria-label={`Open ${channelTitle}'s profile`}
                className="shrink-0 rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <ChannelGlyph channel={channel} size={22} showPresenceDot={false}/>
              </Link>
            ) : (
              <ChannelGlyph channel={channel} size={22} showPresenceDot={false}/>
            )
          ) : (
            <span className="size-[22px] shrink-0 rounded-md bg-muted"/>
          )
        }
        title={
          headerAgentHref ? (
            <Link
              to={headerAgentHref}
              viewTransition
              className="min-w-0 truncate rounded outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {channelTitle}
            </Link>
          ) : channel?.channel_type === "direct" && channel.dm_peer_human_id != null ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{channelTitle}</span>
              <DmPillStatus humanId={channel.dm_peer_human_id} />
            </span>
          ) : (
            channelTitle
          )
        }
        actions={
          <>
            {(pinnedQuery.data?.posts.length ?? 0) > 0 && (
              <PinnedPill
                pins={pinnedQuery.data?.posts ?? []}
                loading={pinnedQuery.isLoading}
                error={pinnedQuery.isError}
                currentUserId={user?.id ?? null}
                members={membersQuery.data?.members ?? []}
                onJump={(postId) => { void jumpToPost(postId); }}
                onUnpin={(p) => { pinMutation.mutate(p); }}
                pinning={pinMutation.isPending}
              />
            )}
            {toggleChatInfo && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={toggleChatInfo}
                      aria-pressed={chatInfoOpen}
                      aria-label={chatInfoOpen ? "Hide channel details" : "Show channel details"}
                      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors ${
                        chatInfoOpen
                          ? "bg-sidebar-foreground/10 text-foreground"
                          : "text-muted-foreground hover:bg-sidebar-foreground/5 hover:text-foreground"
                      }`}
                    >
                      {channel?.channel_type !== "direct" && memberCount > 0 && (
                        <span className="tabular-nums">{memberCount}</span>
                      )}
                      <Icon icon={UserMultiple02Icon} className="size-3.5 shrink-0"/>
                    </button>
                  }
                />
                <TooltipContent side="bottom" align="end">
                  {chatInfoOpen ? "Hide channel details" : "Show channel details"}
                </TooltipContent>
              </Tooltip>
            )}
            {toggleAttachments && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={toggleAttachments}
                      aria-pressed={attachmentsOpen}
                      aria-label={attachmentsOpen ? "Hide attachments" : "Show attachments"}
                      className={`flex h-8 shrink-0 items-center justify-center rounded-lg px-2 text-xs font-medium transition-colors ${
                        attachmentsOpen
                          ? "bg-sidebar-foreground/10 text-foreground"
                          : "text-muted-foreground hover:bg-sidebar-foreground/5 hover:text-foreground"
                      }`}
                    >
                      <Icon icon={AttachmentIcon} className="size-3.5 shrink-0"/>
                    </button>
                  }
                />
                <TooltipContent side="bottom" align="end">
                  {attachmentsOpen ? "Hide attachments" : "Show attachments"}
                </TooltipContent>
              </Tooltip>
            )}
          </>
        }
      />

      {/* Messages — the MessageList component owns the scroll element,
          the virtualizer, and stick-to-bottom logic. We pass it the
          precomputed ``rows`` array and a render function; it handles
          everything from anchor-on-prepend to load-older triggering.
          Clicking empty space focuses the composer. ``min-h-0`` is
          required so the flex child can shrink below the natural
          content height - otherwise the scroll container expands to
          fit every row and the page itself becomes the scroller. */}
      <div
        onClick={(e) => {
          if (e.target === e.currentTarget) inputRef.current?.focus();
        }}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {postsQuery.isLoading && (
          <div
            role="status"
            aria-label="Loading messages"
            className="mx-auto w-full max-w-chat pt-16 pb-4"
          >
            <MessageSkeletons count={5} />
          </div>
        )}
        {!postsQuery.isLoading && rows.length === 0 && (
          <div className="mx-auto flex w-full max-w-chat flex-1 flex-col items-center justify-center px-6 py-12 text-center">
            {channel && (
              <ChannelGlyph
                channel={channel}
                size={72}
                showPresenceDot={false}
                className="rounded-2xl shadow-sm"
              />
            )}
            <h2 className="mt-4 text-lg font-semibold tracking-tight text-foreground">
              {channelTitle}
            </h2>
            <p className="mt-1.5 max-w-xs text-pretty text-sm leading-relaxed text-muted-foreground">
              {channel?.channel_type === "direct" ? (
                <>
                  This is the very beginning of your conversation with{" "}
                  <span className="font-medium text-foreground">{channelTitle}</span>.
                  Say hi{user?.display_name ? `, ${user.display_name}` : ""}! 👋
                </>
              ) : (
                <>
                  This is the start of the{" "}
                  <span className="font-medium text-foreground">{channelTitle}</span>{" "}
                  channel. Send a message to kick things off.
                </>
              )}
            </p>
          </div>
        )}
        {rows.length > 0 && (
          <MessageList
            ref={messageListRef}
            channelKey={channelId}
            rows={rows}
            getRowKey={(row) =>
              row.kind === "post"
                ? `post-${row.post.post_id}`
                : row.kind === "event"
                  ? `event-${row.event.event_id}`
                  : `generating-${row.agentId}`
            }
            composerHeightPx={composerHeight}
            prependShift={history.prependShift.current}
            hasMoreHistory={history.hasMoreOlder}
            onLoadOlder={() => { void history.loadMoreOlder(); }}
            hasMoreNewer={history.hasMoreNewer}
            onLoadNewer={() => { void history.loadMoreNewer(); }}
            autoStickToBottom={!history.isAnchored}
            onAtBottomChange={setIsAtBottom}
            renderRow={(row) => {
              if (row.kind === "generating") {
                return (
                  <GeneratingRow
                    agentId={row.agentId}
                    member={row.member}
                    activity={activity[`agent:${row.agentId}`]}
                    toolSteps={toolTimelines[`agent:${row.agentId}`]}
                    thinkingSteps={thinkingTimelines[`agent:${row.agentId}`]}
                    channelType={channel?.channel_type}
                    optimistic={optimisticAgents.has(`agent:${row.agentId}`)}
                  />
                );
              }
              const isFirstRow = rows.indexOf(row) === 0;
              const headerCommon = (
                <>
                  {row.newDay && (
                    <DaySeparator
                      date={
                        row.kind === "post"
                          ? row.post.created_at
                          : row.event.created_at
                      }
                    />
                  )}
                  {history.isLoadingMore && isFirstRow && (
                    <div role="status" aria-label="Loading earlier messages" className="pb-2">
                      <MessageSkeletons count={3} />
                    </div>
                  )}
                  {!history.hasMoreOlder && isFirstRow && (
                    <p className="py-2 text-center text-[11px] text-muted-foreground/60">
                      That's the beginning of the conversation.
                    </p>
                  )}
                </>
              );
              if (row.kind === "event") {
                return (
                  <>
                    {headerCommon}
                    <SystemMessage event={row.event} currentHumanId={user?.id ?? null} />
                  </>
                );
              }
              const { post, isGroupStart, isGroupEnd, isLatest, showUnreadDivider } = row;
              return (
                <>
                  {showUnreadDivider && <UnreadDivider count={enteredAtUnread} />}
                  {headerCommon}
                  <MessageRow
                    post={post}
                    currentUser={user ?? null}
                    isChannelCreator={
                      user != null && channel?.created_by_human === user.id
                    }
                    isGroupStart={isGroupStart}
                    isGroupEnd={isGroupEnd}
                    isLatest={isLatest}
                    presence={presence}
                    activity={activity}
                    toolTimelines={toolTimelines}
                    thinkingTimelines={thinkingTimelines}
                    finishedToolTraces={finishedToolTraces}
                    finishedThinkingTraces={finishedThinkingTraces}
                    mentions={mentions}
                    members={membersQuery.data?.members ?? []}
                    channelType={channel?.channel_type}
                    onReply={startReply}
                    onJumpToParent={(postId) => { void jumpToPost(postId); }}
                    onToggleReaction={(postId, emoji) => { reactionMutation.mutate({ postId, emoji }); }}
                    onTogglePin={(p) => { pinMutation.mutate(p); }}
                    isEditing={editingPostId === post.post_id}
                    onStartEdit={(p) => { setEditingPostId(p.post_id); }}
                    onSaveEdit={(postId, message) => { editMutation.mutate({ postId, message }); }}
                    onCancelEdit={() => { setEditingPostId(null); }}
                    editSaving={editMutation.isPending}
                    onDelete={(p) => { setPostIdToDelete(p.post_id); }}
                    highlighted={highlightedPostId === post.post_id}
                    queued={row.queued}
                  />
                </>
              );
            }}
          />
        )}
      </div>

      {/* Bottom fade scrim — mirrors the top one. ``absolute`` (scoped to the
          chat column) + ``-z-10`` so it sits behind the composer and messages
          but above the card background; pointer-events-none keeps the gaps
          clickable. Desktop only: on mobile the column is the full document
          height, so ``absolute bottom-0`` would float far below the fold instead
          of hugging the viewport bottom; the composer's own glass covers it. */}
      {!isMobile && (
        <ProgressiveBlur
          side="bottom"
          blur={8}
          className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-16 bg-gradient-to-t from-background to-transparent"
        />
      )}

      {/* Floating two-row composer pill. Owns its own popovers, agent
          target chip, attachment row, and keyboard ladder; the parent just
          feeds it state and handlers. Wrapper ref is forwarded so the
          height-measurement effect still works. */}
      <MessageComposer
        isMobile={isMobile}
        wrapperRef={composerWrapRef}
        inputRef={inputRef}
        draft={draft}
        onDraftChange={setDraft}
        caretPos={caretPos}
        onCaretPosChange={setCaretPos}
        mentionOpen={mentionOpen}
        mentionOptions={mentionOptions}
        activeMentionIndex={activeMentionIndex}
        onActiveMentionIndexChange={setActiveMentionIndex}
        onMentionDismiss={() => { setMentionDismissed(true); }}
        onMentionInsert={insertMention}
        channelOpen={channelOpen}
        channelOptions={channelOptions}
        activeChannelIndex={activeChannelIndex}
        onActiveChannelIndexChange={setActiveChannelIndex}
        onChannelDismiss={() => { setChannelDismissed(true); }}
        onChannelInsert={insertChannel}
        emojiOpen={emojiOpen}
        emojiOptions={emojiOptions}
        activeEmojiIndex={activeEmojiIndex}
        onActiveEmojiIndexChange={setActiveEmojiIndex}
        onEmojiDismiss={() => { setEmojiDismissed(true); }}
        onEmojiInsert={insertEmoji}
        onInsertAtCaret={insertAtCaret}
        replyingTo={replyingTo}
        replyPosterName={posterName}
        onCancelReply={cancelReply}
        autoMention={autoMention}
        onDismissAutoMention={dismissAutoMention}
        manualTargetHandle={manualTargetedAgent}
        onSetManualTarget={setManualTargetedAgent}
        mentions={mentions}
        members={membersQuery.data?.members ?? []}
        attachments={composerAttachments.attachments}
        onAttachmentsAdd={composerAttachments.addFiles}
        onAttachmentRemove={composerAttachments.removeAttachment}
        isUploading={composerAttachments.isUploading}
        isReadyToSend={composerAttachments.isReadyToSend}
        uploadedFileIdsCount={composerAttachments.uploadedFileIds.length}
        onSubmit={handleSend}
        onEditLast={editLastOwnMessage}
        isSending={sendMutation.isPending}
        isChatAtBottom={history.isAnchored ? false : isAtBottom}
        onScrollChatToBottom={
          history.isAnchored
            ? history.returnToPresent
            : () => { messageListRef.current?.scrollToBottom("smooth"); }
        }
        activityLabel={activityLabel}
        activityPeople={activityPeople}
        adminCommandsEnabled={
          channel?.channel_type === "direct" &&
          (membersQuery.data?.members ?? []).some((m) => m.agent_id != null)
        }
        onTyping={signalTyping}
        placeholder={
          channel
            ? channel.channel_type === "direct"
              ? `Message ${channel.display_name ?? channel.name}`
              : `Message #${channel.name}`
            : undefined
        }
      />

      {/* Delete-message confirmation. The mutation is optimistic, so the
          dialog closes immediately on confirm. */}
      <Dialog
        open={postIdToDelete !== null}
        onOpenChange={(next) => { if (!next) setPostIdToDelete(null); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              <Icon icon={Delete02Icon} className="text-destructive" />
              Delete message?
            </DialogTitle>
            <DialogDescription>
              The message and its attachments will be permanently removed. This
              can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => { setPostIdToDelete(null); }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (postIdToDelete !== null) deleteMutation.mutate(postIdToDelete);
                setPostIdToDelete(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </ProfileMenuProvider>
  );
}

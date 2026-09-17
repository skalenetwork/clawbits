import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AttachmentIcon, Delete02Icon, PinIcon, UserMultiple02Icon } from "@hugeicons/core-free-icons";

import type { ChannelOutletContext } from "@/layouts/AppShell";
import { useAuth } from "@/context/AuthContext";
import {
  createMmChannelPost,
  deleteMmChannelPost,
  editMmChannelPost,
  getMmChannel,
  listDiscoverableMmChannels,
  listMmChannelEvents,
  listMmChannelMembers,
  listMmChannelPosts,
  listMmChannels,
  markMmChannelRead,
  toggleMmPostReaction,
  type MmChannel,
  type MmChannelMember,
  type MmChannelPost,
  type MmFile,
  type MmPostListPayload,
} from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { formatChannelTitle } from "@/lib/formatting";
import { draftStore } from "@/lib/messageDrafts";
import { trackRecentChannel } from "@/lib/desktop";
import { errMsg, toast } from "@/lib/toast";
import { computePendingAutoMention } from "@/lib/autoMention";
import { mentionHandle, mentionLabel } from "@/lib/messageHelpers";
import { buildTimeline, decorateRows, generatingAgentsOf, postsOf, queuedOwnPostIdsOf } from "@/lib/channelTimeline";
import { useIsMobile } from "@/hooks/use-mobile";
import { useChannelAttachments } from "@/hooks/useChannelAttachments";
import { useChannelDragDrop } from "@/hooks/useChannelDragDrop";
import { memberKey, useChannelEvents } from "@/hooks/useChannelEvents";
import { useChannelHistory } from "@/hooks/useChannelHistory";
import { useChannelPresence } from "@/hooks/useChannelPresence";
import { useLatestRef } from "@/hooks/useLatestRef";
import { usePinToggle, usePinnedPosts } from "@/hooks/usePinnedPosts";
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
import { ChannelDropOverlay } from "@/components/ChannelDropOverlay";
import { ChannelGlyph } from "@/components/ChannelGlyph";
import { MentionsContext, type MessageMentions } from "@/components/mentionsContext";
import { MessageComposer, type ComposerHandle, type TypingPerson } from "@/components/MessageComposer";
import { PageHeader } from "@/components/PageHeader";
import { ProfileMenuProvider } from "@/components/ProfileMenu";
import { ProgressiveBlur } from "@/components/ProgressiveBlur";
import { UnreadDivider } from "@/components/UnreadDivider";
import { DmPillStatus, PanelToggle } from "@/components/chat/ChannelHeaderPills";
import { DaySeparator, MessageSkeletons } from "@/components/chat/dividers";
import { GeneratingRow } from "@/components/chat/GeneratingRow";
import { MessageList, type MessageListHandle } from "@/components/chat/MessageList";
import { MessageRow } from "@/components/chat/MessageRow";
import { SystemMessage } from "@/components/chat/SystemMessage";

const POSTS_POLL_IDLE_MS = 30_000;
const POSTS_POLL_FAST_MS = 4_000;
// An IronClaw reply is a single post.created with no streaming follow-ups, so poll fast after a send to self-heal a dropped event.
const POSTS_POLL_RECENT_SEND_MS = 60_000;
const NO_POSTS: MmChannelPost[] = [];
const NO_MEMBERS: MmChannelMember[] = [];

interface ChannelsPage {
  channels: MmChannel[];
  total: number;
}
type Reactions = NonNullable<MmChannelPost["reactions"]>;

function findCachedChannel(queryClient: QueryClient, channelId: string): MmChannel | undefined {
  for (const [, data] of queryClient.getQueriesData<ChannelsPage>({ queryKey: queryKeys.mm.channelsAll })) {
    const channel = data?.channels.find((c) => c.channel_id === channelId);
    if (channel) return channel;
  }
  return undefined;
}

function mentionTokensForViewer(userId: number | null, members: readonly MmChannelMember[]): Set<string> {
  const tokens = new Set<string>();
  if (userId == null) return tokens;
  tokens.add(`user-${String(userId)}`);
  const me = members.find((m) => m.human_id === userId);
  if (!me) return tokens;
  if (me.display_name) tokens.add(me.display_name.toLowerCase().replace(/\s+/g, ""));
  const handle = mentionHandle(me).toLowerCase();
  if (handle) tokens.add(handle);
  return tokens;
}

function toggledReactions(reactions: Reactions, emoji: string, userId: number): Reactions {
  const existing = reactions.find((r) => r.emoji === emoji);
  if (!existing) return [...reactions, { emoji, count: 1, human_ids: [userId], agent_ids: [] }];
  const mine = existing.human_ids.includes(userId);
  const count = existing.count + (mine ? -1 : 1);
  if (count === 0) return reactions.filter((r) => r.emoji !== emoji);
  const human_ids = mine ? existing.human_ids.filter((id) => id !== userId) : [...existing.human_ids, userId];
  return reactions.map((r) => (r.emoji === emoji ? { ...r, human_ids, count } : r));
}

export default function ChannelPage() {
  const { channelId } = useParams<{ channelId: string }>();
  if (!channelId) {
    return <p className="py-12 text-center text-sm text-muted-foreground">No channel selected</p>;
  }
  return <ChannelView key={channelId} channelId={channelId} />;
}

function ChannelView({ channelId }: { channelId: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const panels = useOutletContext<ChannelOutletContext | undefined>();
  const postsKey = queryKeys.mm.channelPosts(channelId, 50, 0);

  const [storedDraft] = useState(() => (user ? draftStore.get(user.id, channelId) : null));
  const [replyingTo, setReplyingTo] = useState(storedDraft?.reply ?? null);
  const [manualTargetedAgent, setManualTargetedAgent] = useState(storedDraft?.targetAgentId ?? null);
  // State, not a ref: arming it re-renders so React Query reschedules the refetch timer at once.
  const [fastPollUntil, setFastPollUntil] = useState(0);
  const [editingPostId, setEditingPostId] = useState<number | null>(null);
  const [postIdToDelete, setPostIdToDelete] = useState<number | null>(null);
  const [highlightedPostId, setHighlightedPostId] = useState<number | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [enteredAtUnread] = useState(() => findCachedChannel(queryClient, channelId)?.unread_count ?? 0);
  const [firstUnreadPostId, setFirstUnreadPostId] = useState<number | null>(null);
  const [channelEnteredAt] = useState(Date.now);
  const [autoMentionNow, setAutoMentionNow] = useState(Date.now);
  const [dismissedAutoMentionKey, setDismissedAutoMentionKey] = useState<string | null>(null);

  const highlightTimerRef = useRef<number | undefined>(undefined);
  const pendingJumpRef = useRef<number | null>(null);
  const lastMarkedRef = useRef(0);
  const handledMsgRef = useRef<string | null>(null);
  const messageListRef = useRef<MessageListHandle>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);

  const {
    attachments,
    addFiles,
    removeAttachment,
    clear: clearAttachments,
    isUploading,
    isReadyToSend,
    uploadedFileIds,
  } = useChannelAttachments({ channelId });

  const { isDragging } = useChannelDragDrop({
    onDrop: (files) => {
      addFiles(files);
      requestAnimationFrame(() => { composerRef.current?.focus(); });
    },
  });

  useLayoutEffect(() => {
    const wrap = composerWrapRef.current;
    const column = columnRef.current;
    if (!wrap || !column) return;
    const publishHeight = () => {
      const height = Math.ceil(column.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top);
      column.style.setProperty("--composer-height", `${String(height)}px`);
    };
    publishHeight();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        publishHeight();
        if (!isMobile && messageListRef.current?.getIsAtBottom()) messageListRef.current.scrollToBottom();
      });
    });
    // Border box: iOS toggles the composer's safe-area padding with the keyboard, which a content box misses.
    observer.observe(wrap, { box: "border-box" });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [isMobile]);

  const channelQuery = useQuery({
    queryKey: queryKeys.mm.channel(channelId),
    queryFn: () => getMmChannel(channelId),
    placeholderData: () => findCachedChannel(queryClient, channelId),
  });
  const channel = channelQuery.data;
  const isDirect = channel?.channel_type === "direct";
  const channelOrgId = channel?.org_id ?? null;

  const postsQuery = useQuery({
    queryKey: postsKey,
    queryFn: () => listMmChannelPosts(channelId, 50, 0),
    refetchInterval: (query) =>
      Date.now() < fastPollUntil || query.state.data?.posts.some((p) => p.status === "streaming")
        ? POSTS_POLL_FAST_MS
        : POSTS_POLL_IDLE_MS,
    refetchOnWindowFocus: true,
  });
  const latestPosts = postsQuery.data?.posts ?? NO_POSTS;

  const eventsQuery = useQuery({
    queryKey: queryKeys.mm.channelEvents(channelId, 100),
    queryFn: () => listMmChannelEvents(channelId, 100),
  });

  const membersQuery = useQuery({
    queryKey: queryKeys.mm.channelMembers(channelId),
    queryFn: () => listMmChannelMembers(channelId),
  });
  const members = membersQuery.data?.members ?? NO_MEMBERS;

  const joinedChannels = useQuery({
    queryKey: queryKeys.mm.channels(channelOrgId),
    queryFn: () => listMmChannels(channelOrgId),
    enabled: Boolean(channelOrgId),
    staleTime: 30_000,
  }).data?.channels;
  const discoverableChannels = useQuery({
    queryKey: queryKeys.mm.discoverableChannels(channelOrgId),
    queryFn: () => listDiscoverableMmChannels(channelOrgId ?? ""),
    enabled: Boolean(channelOrgId),
    staleTime: 60_000,
  }).data?.channels;

  const pinnedCount = usePinnedPosts(channelId).data?.posts.length ?? 0;
  const { mutate: togglePin } = usePinToggle(channelId);

  const history = useChannelHistory({
    channelId,
    latestPosts,
    refetchPosts: () => { void postsQuery.refetch(); },
    scrollToBottom: () => { messageListRef.current?.scrollToBottom(); },
  });

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

  const channelTitle = formatChannelTitle(channel?.display_name ?? channel?.name, isDirect ? "Direct message" : "Channel");

  useEffect(() => {
    if (channel) trackRecentChannel({ id: channelId, name: channelTitle, path: `/channels/${channelId}` });
  }, [channelId, channel, channelTitle]);

  const latestPostId = useMemo(
    () => Math.max(0, ...latestPosts.filter((p) => p.status === "published").map((p) => p.post_id)),
    [latestPosts],
  );

  useEffect(() => {
    const markRead = () => {
      if (latestPostId <= lastMarkedRef.current || document.visibilityState === "hidden") return;
      lastMarkedRef.current = latestPostId;
      queryClient.setQueriesData<ChannelsPage>({ queryKey: queryKeys.mm.channelsAll }, (prev) =>
        prev?.channels.some((c) => c.channel_id === channelId)
          ? { ...prev, channels: prev.channels.map((c) => (c.channel_id === channelId ? { ...c, unread_count: 0 } : c)) }
          : prev,
      );
      void markMmChannelRead(channelId, latestPostId).catch(() => { lastMarkedRef.current = 0; });
    };
    markRead();
    document.addEventListener("visibilitychange", markRead);
    return () => { document.removeEventListener("visibilitychange", markRead); };
  }, [channelId, latestPostId, queryClient]);

  const setPosts = (update: (page: MmPostListPayload) => MmPostListPayload) => {
    queryClient.setQueryData<MmPostListPayload>(postsKey, (prev) => prev && update(prev));
  };
  const snapshotPosts = async () => {
    await queryClient.cancelQueries({ queryKey: postsKey });
    return { prev: queryClient.getQueryData<MmPostListPayload>(postsKey) };
  };
  const rollbackPosts = (ctx: { prev?: MmPostListPayload } | undefined, err: unknown, message: string) => {
    if (ctx?.prev) queryClient.setQueryData(postsKey, ctx.prev);
    toast.error(errMsg(err, message));
  };
  const replacePost = (updated: MmChannelPost) => {
    setPosts((page) => ({ ...page, posts: page.posts.map((p) => (p.post_id === updated.post_id ? updated : p)) }));
  };

  const { mutateAsync: sendPost, isPending: isSending } = useMutation({
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
      const replyBefore = replyingTo;
      const targetBefore = manualTargetedAgent;
      setReplyingTo(null);
      setManualTargetedAgent(null);
      clearAttachments();
      // Not awaited: the queryFn ignores abort signals, so awaiting would stall the send behind an unrelated GET.
      void queryClient.cancelQueries({ queryKey: postsKey });
      const optimistic: MmChannelPost = {
        post_id: -Date.now(),
        channel_id: channelId,
        agent_id: null,
        human_id: user?.id ?? null,
        poster_display_name: user?.display_name ?? null,
        avatar: user?.avatar ?? null,
        message: vars.message,
        created_at: new Date().toISOString(),
        status: "published",
        updated_at: null,
        edited_at: null,
        parent_post_id: vars.parentPostId,
        parent_preview: replyBefore && {
          post_id: replyBefore.post_id,
          agent_id: replyBefore.agent_id,
          human_id: replyBefore.human_id,
          poster_display_name: replyBefore.poster_display_name,
          message_excerpt: replyBefore.message,
          status: replyBefore.status,
          attachment_count: replyBefore.files?.length ?? 0,
        },
        link_preview: null,
        reactions: [],
        files: vars.filesSnapshot,
        client_msg_uuid: vars.clientMsgUuid,
      };
      queryClient.setQueryData<MmPostListPayload>(postsKey, (prev) =>
        prev
          ? { ...prev, posts: [optimistic, ...prev.posts], total: prev.total + 1 }
          : { posts: [optimistic], total: 1, limit: 50, offset: 0 },
      );
      if (vars.targetAgentId) {
        markAgentGenerating(vars.targetAgentId);
        setFastPollUntil(Date.now() + POSTS_POLL_RECENT_SEND_MS);
      }
      return { optimistic, replyBefore, targetBefore };
    },
    onSuccess: (created, _vars, ctx) => {
      queryClient.setQueryData<MmPostListPayload>(postsKey, (prev) => {
        if (!prev) return { posts: [created], total: 1, limit: 50, offset: 0 };
        const uuid = created.client_msg_uuid ?? ctx?.optimistic.client_msg_uuid;
        const posts = prev.posts.filter(
          (p) => !(uuid && p.client_msg_uuid === uuid && p.post_id < 0) && p.post_id !== created.post_id,
        );
        return { ...prev, posts: [created, ...posts] };
      });
    },
    onError: (err, _vars, ctx) => {
      if (ctx) {
        queryClient.setQueryData<MmPostListPayload>(postsKey, (prev) => {
          const posts = prev?.posts.filter((p) => p.post_id !== ctx.optimistic.post_id);
          return prev && posts && posts.length !== prev.posts.length
            ? { ...prev, posts, total: Math.max(0, prev.total - (prev.posts.length - posts.length)) }
            : prev;
        });
        if (ctx.replyBefore) setReplyingTo(ctx.replyBefore);
        if (ctx.targetBefore) setManualTargetedAgent(ctx.targetBefore);
      }
      toast.error(errMsg(err, "Send failed"));
    },
  });

  const { mutate: saveEdit, isPending: editPending } = useMutation({
    mutationFn: (vars: { postId: number; message: string }) => editMmChannelPost(vars.postId, vars.message),
    onMutate: async ({ postId, message }) => {
      const ctx = await snapshotPosts();
      const editedAt = new Date().toISOString();
      setPosts((page) => ({
        ...page,
        posts: page.posts.map((p) => (p.post_id === postId ? { ...p, message, edited_at: editedAt } : p)),
      }));
      return ctx;
    },
    onError: (err, _vars, ctx) => { rollbackPosts(ctx, err, "Couldn't save edit"); },
    onSuccess: (updated) => {
      setEditingPostId(null);
      replacePost(updated);
    },
  });

  const { mutate: deletePost } = useMutation({
    mutationFn: deleteMmChannelPost,
    onMutate: async (postId) => {
      const ctx = await snapshotPosts();
      setPosts((page) => ({
        ...page,
        posts: page.posts.filter((p) => p.post_id !== postId),
        total: Math.max(0, page.total - 1),
      }));
      return ctx;
    },
    onError: (err, _postId, ctx) => { rollbackPosts(ctx, err, "Couldn't delete message"); },
  });

  const { mutate: toggleReaction } = useMutation({
    mutationFn: (vars: { postId: number; emoji: string }) => toggleMmPostReaction(vars.postId, vars.emoji),
    onMutate: async ({ postId, emoji }) => {
      const ctx = await snapshotPosts();
      if (user) {
        setPosts((page) => ({
          ...page,
          posts: page.posts.map((p) =>
            p.post_id === postId ? { ...p, reactions: toggledReactions(p.reactions ?? [], emoji, user.id) } : p,
          ),
        }));
      }
      return ctx;
    },
    onError: (err, _vars, ctx) => { rollbackPosts(ctx, err, "Couldn't toggle reaction"); },
    onSuccess: replacePost,
  });

  const flashPost = (postId: number) => {
    setHighlightedPostId(postId);
    window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => { setHighlightedPostId(null); }, 1500);
  };

  useEffect(() => () => { window.clearTimeout(highlightTimerRef.current); }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || editingPostId != null) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      void navigate("/home");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [editingPostId, navigate]);

  const timeline = useMemo(
    () => buildTimeline(history.posts, eventsQuery.data?.events ?? []),
    [history.posts, eventsQuery.data],
  );
  if (firstUnreadPostId == null && enteredAtUnread > 0) {
    const posts = postsOf(timeline);
    const anchor = posts[Math.max(0, posts.length - enteredAtUnread)];
    if (anchor) setFirstUnreadPostId(anchor.post_id);
  }
  const generatingAgents = useMemo(
    () => generatingAgentsOf(presence, history.posts, members),
    [presence, history.posts, members],
  );
  const queuedOwnPostIds = useMemo(
    () => queuedOwnPostIdsOf(history.posts, generatingAgents.length > 0, user?.id),
    [history.posts, generatingAgents.length, user?.id],
  );
  const rows = useMemo(
    () => decorateRows({ timeline, firstUnreadPostId, generatingAgents, queuedOwnPostIds }),
    [timeline, firstUnreadPostId, generatingAgents, queuedOwnPostIds],
  );
  const rowsRef = useLatestRef(rows);

  const jumpToPost = async (postId: number) => {
    const index = rowsRef.current.findIndex((r) => r.kind === "post" && r.post.post_id === postId);
    if (index >= 0) {
      messageListRef.current?.scrollToIndex(index, true);
      flashPost(postId);
      return;
    }
    pendingJumpRef.current = postId;
    await history.anchorAround(postId);
  };

  // A re-anchor swaps in unmeasured rows, so align instantly across a few frames before flashing.
  useEffect(() => {
    const target = pendingJumpRef.current;
    if (target == null) return;
    const index = rows.findIndex((r) => r.kind === "post" && r.post.post_id === target);
    if (index < 0) return;
    pendingJumpRef.current = null;
    let raf = 0;
    const settle = (pass: number) => {
      messageListRef.current?.scrollToIndex(index, false);
      if (pass < 3) raf = requestAnimationFrame(() => { settle(pass + 1); });
      else flashPost(target);
    };
    settle(0);
    return () => { cancelAnimationFrame(raf); };
  }, [rows]);

  const jumpToDeepLink = useEffectEvent((postId: number) => { void jumpToPost(postId); });
  useEffect(() => {
    const raw = searchParams.get("msg");
    if (!raw) {
      handledMsgRef.current = null;
      return;
    }
    const postId = Number(raw);
    if (!postsQuery.data || handledMsgRef.current === raw || !Number.isFinite(postId)) return;
    handledMsgRef.current = raw;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("msg");
        return next;
      },
      { replace: true },
    );
    jumpToDeepLink(postId);
  }, [searchParams, setSearchParams, postsQuery.data]);

  const mentions = useMemo<MessageMentions>(() => {
    const memberByToken = new Map<string, MmChannelMember>();
    for (const m of members) {
      const add = (token: string) => { if (token) memberByToken.set(token, m); };
      if (m.agent_id) add(m.agent_id.toLowerCase());
      if (m.display_name) add(m.display_name.toLowerCase().replace(/\s+/g, ""));
      if (!m.agent_id) add(mentionHandle(m).toLowerCase());
      if (m.human_id != null) add(`user-${String(m.human_id)}`);
    }
    const channelsByToken = new Map<string, MmChannel>();
    for (const c of joinedChannels ?? []) {
      if (c.channel_type !== "direct") channelsByToken.set(c.name.toLowerCase(), c);
    }
    for (const c of discoverableChannels ?? []) {
      const token = c.name.toLowerCase();
      if (c.channel_type !== "direct" && !channelsByToken.has(token)) channelsByToken.set(token, c);
    }
    return {
      memberByToken,
      channelsByToken,
      currentUserChannelIds: new Set(joinedChannels?.map((c) => c.channel_id)),
    };
  }, [members, joinedChannels, discoverableChannels]);

  useEffect(() => {
    const interval = window.setInterval(() => { setAutoMentionNow(Date.now()); }, 30_000);
    return () => { window.clearInterval(interval); };
  }, []);

  const pendingAgentMention = useMemo(
    () => computePendingAutoMention({
      currentUserId: user?.id ?? null,
      isDirectChannel: isDirect,
      members,
      posts: latestPosts,
      replyingTo,
      handleFor: mentionHandle,
      labelFor: mentionLabel,
      myMentionTokens: mentionTokensForViewer(user?.id ?? null, members),
      nowMs: autoMentionNow,
      windowMs: 5 * 60_000,
      channelEnteredAtMs: channelEnteredAt,
    }),
    [user?.id, isDirect, members, latestPosts, replyingTo, autoMentionNow, channelEnteredAt],
  );
  const autoMention = pendingAgentMention?.triggerKey !== dismissedAutoMentionKey ? pendingAgentMention : null;

  const activityPeople = useMemo(
    () => Object.entries(presence).flatMap(([key, status]): TypingPerson[] => {
      const [kind, id] = key.split(":", 2);
      if (kind !== "human" || id === String(user?.id) || (status !== "typing" && status !== "generating")) return [];
      return [{ key, displayName: members.find((m) => String(m.human_id) === id)?.display_name ?? `User ${id}`, status }];
    }),
    [presence, members, user?.id],
  );

  const send = (text: string) => {
    const msg = text.trim();
    const explicitTarget = manualTargetedAgent ?? autoMention?.handle ?? null;
    const prefix = explicitTarget && `@${explicitTarget}`;
    const message = prefix && !msg.toLowerCase().includes(prefix.toLowerCase()) ? (msg ? `${prefix} ${msg}` : prefix) : msg;
    const lowered = message.toLowerCase();
    const targetAgentId =
      explicitTarget
      ?? (isDirect ? members.find((m) => m.agent_id != null)?.agent_id : undefined)
      ?? members.find((m) => m.agent_id != null && lowered.includes(`@${mentionHandle(m).toLowerCase()}`))?.agent_id
      ?? null;
    const now = new Date().toISOString();
    const filesSnapshot = attachments.flatMap((a): MmFile[] =>
      a.status === "uploaded" && a.fileId
        ? [{
            file_id: a.fileId,
            channel_id: channelId,
            filename: a.file.name,
            content_type: a.file.type || "application/octet-stream",
            size_bytes: a.file.size,
            status: "uploaded",
            width: null,
            height: null,
            duration_ms: null,
            created_at: now,
            uploaded_at: now,
            download_url: null,
            thumbnail_url: null,
          }]
        : [],
    );
    history.returnToPresent();
    const sent = sendPost({
      message,
      parentPostId: replyingTo?.post_id ?? null,
      fileIds: uploadedFileIds,
      clientMsgUuid: crypto.randomUUID(),
      filesSnapshot,
      targetAgentId,
    });
    messageListRef.current?.scrollToBottom(true);
    return sent;
  };

  const startReply = (post: MmChannelPost) => {
    setReplyingTo(post);
    requestAnimationFrame(() => { composerRef.current?.focus(); });
  };

  const editLastOwnMessage = () => {
    const last = latestPosts.reduce<MmChannelPost | null>(
      (best, p) =>
        p.human_id === user?.id && p.agent_id == null && p.status === "published" && (!best || p.post_id > best.post_id)
          ? p
          : best,
      null,
    );
    if (last) setEditingPostId(last.post_id);
  };

  const agentHref =
    channel?.channel_type === "direct" && channel.dm_peer_agent_id
      ? `/agents/${encodeURIComponent(channel.dm_peer_agent_id)}`
      : null;
  const glyph = channel
    ? <ChannelGlyph channel={channel} size={20} showPresenceDot={false}/>
    : <span className="size-5 shrink-0 rounded-md bg-muted"/>;
  const memberCount = membersQuery.data?.total ?? members.length;
  const isChannelCreator = user != null && channel?.created_by_human === user.id;

  return (
    <MentionsContext value={mentions}>
    <ProfileMenuProvider
      orgId={channelOrgId}
      currentUserId={user?.id ?? null}
      onMentionInsert={(handle) => { composerRef.current?.insert(`@${handle} `); }}
    >
    <div ref={columnRef} className="relative isolate flex h-full min-h-0 flex-1 flex-col">
      <ChannelDropOverlay show={isDragging} />
      <PageHeader
        leading={
          agentHref ? (
            <Link
              to={agentHref}
              viewTransition
              aria-label={`Open ${channelTitle}'s profile`}
              className="shrink-0 rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {glyph}
            </Link>
          ) : glyph
        }
        title={
          agentHref ? (
            <Link
              to={agentHref}
              viewTransition
              className="min-w-0 truncate rounded text-muted-foreground outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {channelTitle}
            </Link>
          ) : channel?.channel_type === "direct" && channel.dm_peer_human_id != null ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-muted-foreground">{channelTitle}</span>
              <DmPillStatus humanId={channel.dm_peer_human_id} />
            </span>
          ) : (
            <span className="truncate text-muted-foreground">{channelTitle}</span>
          )
        }
        actions={
          <>
            {panels && pinnedCount > 0 && (
              <PanelToggle open={panels.panel === "pinned"} onToggle={() => { panels.togglePanel("pinned"); }} noun="pinned messages">
                <span className="tabular-nums">{pinnedCount}</span>
                <Icon icon={PinIcon} className="size-3.5 shrink-0"/>
              </PanelToggle>
            )}
            {panels && (
              <PanelToggle open={panels.panel === "info"} onToggle={() => { panels.togglePanel("info"); }} noun="channel details">
                {!isDirect && memberCount > 0 && <span className="tabular-nums">{memberCount}</span>}
                <Icon icon={UserMultiple02Icon} className="size-3.5 shrink-0"/>
              </PanelToggle>
            )}
            {panels && (
              <PanelToggle open={panels.panel === "attachments"} onToggle={() => { panels.togglePanel("attachments"); }} noun="attachments">
                <Icon icon={AttachmentIcon} className="size-3.5 shrink-0"/>
              </PanelToggle>
            )}
          </>
        }
      />

      <div
        onClick={(e) => {
          if (e.target === e.currentTarget) composerRef.current?.focus();
        }}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {postsQuery.isLoading && (
          <div role="status" aria-label="Loading messages" className="mx-auto w-full max-w-chat pt-16 pb-4">
            <MessageSkeletons count={5} />
          </div>
        )}
        {!postsQuery.isLoading && rows.length === 0 && (
          <div className="mx-auto flex w-full max-w-chat flex-1 flex-col items-center justify-center px-6 py-12 text-center">
            {channel && (
              <ChannelGlyph channel={channel} size={72} showPresenceDot={false} className="rounded-2xl shadow-sm" />
            )}
            <h2 className="mt-4 text-lg font-semibold tracking-tight text-foreground">{channelTitle}</h2>
            <p className="mt-1.5 max-w-xs text-pretty text-sm leading-relaxed text-muted-foreground">
              {isDirect ? (
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
            rows={rows}
            getRowKey={(row) =>
              row.kind === "post"
                ? `post-${row.post.post_id}`
                : row.kind === "event"
                  ? `event-${row.event.event_id}`
                  : `generating-${row.agentId}`
            }
            hasMoreOlder={history.hasMoreOlder}
            onLoadOlder={() => { void history.loadMoreOlder(); }}
            hasMoreNewer={history.hasMoreNewer}
            onLoadNewer={() => { void history.loadMoreNewer(); }}
            autoStickToBottom={!history.isAnchored}
            onAtBottomChange={setIsAtBottom}
            renderRow={(row, index) => {
              if (row.kind === "generating") {
                const key = memberKey("agent", row.agentId);
                return (
                  <GeneratingRow
                    agentId={row.agentId}
                    member={row.member}
                    activity={activity[key]}
                    toolSteps={toolTimelines[key]}
                    thinkingSteps={thinkingTimelines[key]}
                    optimistic={optimisticAgents.has(key)}
                  />
                );
              }
              const lead = (
                <>
                  {row.newDay && (
                    <DaySeparator date={row.kind === "post" ? row.post.created_at : row.event.created_at} />
                  )}
                  {index === 0 && history.isLoadingMore && (
                    <div role="status" aria-label="Loading earlier messages" className="pb-2">
                      <MessageSkeletons count={3} />
                    </div>
                  )}
                  {index === 0 && !history.hasMoreOlder && (
                    <p className="py-2 text-center text-[11px] text-muted-foreground/60">
                      That's the beginning of the conversation.
                    </p>
                  )}
                </>
              );
              if (row.kind === "event") {
                return (
                  <>
                    {lead}
                    <SystemMessage event={row.event} currentHumanId={user?.id ?? null} />
                  </>
                );
              }
              const { post } = row;
              const agentKey = post.status === "streaming" && post.agent_id ? memberKey("agent", post.agent_id) : null;
              return (
                <>
                  {row.showUnreadDivider && <UnreadDivider count={enteredAtUnread} />}
                  {lead}
                  <MessageRow
                    post={post}
                    currentUserId={user?.id ?? null}
                    isChannelCreator={isChannelCreator}
                    isGroupStart={row.isGroupStart}
                    activity={agentKey ? activity[agentKey] : undefined}
                    toolSteps={agentKey ? toolTimelines[agentKey] : undefined}
                    thinkingSteps={agentKey ? thinkingTimelines[agentKey] : undefined}
                    finishedToolSteps={finishedToolTraces[post.post_id]}
                    finishedThinkingSteps={finishedThinkingTraces[post.post_id]}
                    members={members}
                    channelType={channel?.channel_type}
                    onReply={startReply}
                    onJumpToParent={jumpToPost}
                    onToggleReaction={toggleReaction}
                    onTogglePin={togglePin}
                    isEditing={editingPostId === post.post_id}
                    onEdit={setEditingPostId}
                    onSaveEdit={saveEdit}
                    editSaving={editingPostId === post.post_id && editPending}
                    onDelete={setPostIdToDelete}
                    highlighted={highlightedPostId === post.post_id}
                    queued={row.queued}
                  />
                </>
              );
            }}
          />
        )}
      </div>

      {!isMobile && (
        <ProgressiveBlur
          side="bottom"
          blur={8}
          className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-16 bg-gradient-to-t from-background to-transparent"
        />
      )}

      <MessageComposer
        ref={composerRef}
        isMobile={isMobile}
        wrapperRef={composerWrapRef}
        orgId={channelOrgId}
        channelId={channelId}
        userId={user?.id ?? null}
        channelType={channel?.channel_type}
        members={members}
        replyingTo={replyingTo}
        onCancelReply={() => {
          setReplyingTo(null);
          composerRef.current?.focus();
        }}
        autoMention={autoMention}
        onDismissAutoMention={() => {
          if (pendingAgentMention) setDismissedAutoMentionKey(pendingAgentMention.triggerKey);
        }}
        manualTargetHandle={manualTargetedAgent}
        onSetManualTarget={setManualTargetedAgent}
        attachments={attachments}
        onAttachmentsAdd={addFiles}
        onAttachmentRemove={removeAttachment}
        isUploading={isUploading}
        isReadyToSend={isReadyToSend}
        uploadedFileIdsCount={uploadedFileIds.length}
        onSubmit={send}
        onEditLast={editLastOwnMessage}
        isSending={isSending}
        isChatAtBottom={!history.isAnchored && isAtBottom}
        onScrollChatToBottom={
          history.isAnchored ? history.returnToPresent : () => { messageListRef.current?.scrollToBottom(true); }
        }
        activityPeople={activityPeople}
        agentDm={isDirect && members.some((m) => m.agent_id != null)}
        onTyping={signalTyping}
        placeholder={channel && (isDirect ? `Message ${channel.display_name ?? channel.name}` : `Message #${channel.name}`)}
      />

      <Dialog open={postIdToDelete !== null} onOpenChange={(next) => { if (!next) setPostIdToDelete(null); }}>
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
            <Button type="button" variant="ghost" onClick={() => { setPostIdToDelete(null); }}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (postIdToDelete !== null) deletePost(postIdToDelete);
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
    </MentionsContext>
  );
}

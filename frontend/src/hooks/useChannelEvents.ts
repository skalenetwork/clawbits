import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openSseStream } from "@/lib/sse";
import { queryKeys } from "@/lib/queryKeys";
import { channelFileListPrefix, channelLinksQueryKey } from "@/hooks/useChannelFileList";
import { parseUtcTimestamp } from "@/lib/formatting";
import { stitchThinkingTail } from "@/lib/thinkingStitch";
import { updateAgentPresence } from "@/hooks/useAgentPresence";
import { updateUserPresence } from "@/hooks/useUserPresence";
import { useLatestRef } from "@/hooks/useLatestRef";
import type {
  GlobalUserStatus,
  MmChannelEvent,
  MmChannelEventListPayload,
  MmChannelMember,
  MmChannelPost,
  MmPostListPayload,
} from "@/lib/api";

type MemberStatus = "online" | "idle" | "typing" | "generating" | "offline";

export type PresenceMap = Record<string, MemberStatus>;

export interface AgentActivity {
  kind: "generating" | "thinking" | "tool" | "tool_done";
  label?: string;
  tool?: string;
  ok?: boolean;
  duration_ms?: number;
}

export interface ToolStep {
  id: number;
  tool: string;
  label?: string;
  status: "running" | "done" | "error";
  duration_ms?: number;
}

export interface ThinkingStep {
  id: number;
  text: string;
  status: "running" | "done";
}

interface MemberStatusData {
  member_kind: string;
  member_id: string;
  status: MemberStatus;
  activity?: AgentActivity;
}

type ServerEvent =
  | { type: "post.created" | "post.updated"; data: MmChannelPost }
  | { type: "post.deleted"; data: { post_id: number } }
  | { type: "member.status"; data: MemberStatusData }
  | { type: "presence.snapshot"; data: { members: MemberStatusData[] } }
  | {
      type: "user.status";
      data: { human_id: number; status: GlobalUserStatus; last_seen_at: string | null; last_seen_label?: string | null };
    }
  | { type: "agent.status"; data: { agent_id: string; last_alive_at: string | null } }
  | { type: "member.read"; data: { human_id?: number; agent_id?: string; last_read_post_id: number } }
  | { type: "channel.event"; data: MmChannelEvent };

// One counter for tool and thinking steps: TurnTrace rebuilds the turn's order by sorting on id.
let traceSeq = 0;

// Mirrors STATUS_TTL_SECONDS in clawbits/realtime/bus.py; Redis expiry never broadcasts, so clear locally.
const PRESENCE_TTL_MS: Partial<Record<MemberStatus, number>> = {
  typing: 6_000,
  generating: 15_000,
};

// A timer, not rAF: rAF pauses in background tabs and would strand streamed patches.
const FLUSH_DELAY_MS = 32;

const URL_RE = /https?:\/\//i;

export function memberKey(kind: string, id: string | number): string {
  return `${kind}:${String(id)}`;
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

// Monotonic guard: a stale or out-of-order patch never regresses a post.
function versionOf(p: MmChannelPost): number {
  return Math.max(...[p.created_at, p.updated_at, p.edited_at].map((s) => (s ? parseUtcTimestamp(s).getTime() || 0 : 0)));
}

export function useChannelEvents(channelId: string) {
  const qc = useQueryClient();
  const [presence, setPresence] = useState<PresenceMap>({});
  const [activity, setActivity] = useState<Record<string, AgentActivity>>({});
  const [toolTimelines, setToolTimelines] = useState<Record<string, ToolStep[]>>({});
  const [thinkingTimelines, setThinkingTimelines] = useState<Record<string, ThinkingStep[]>>({});
  const [finishedToolTraces, setFinishedToolTraces] = useState<Record<number, ToolStep[]>>({});
  const [finishedThinkingTraces, setFinishedThinkingTraces] = useState<Record<number, ThinkingStep[]>>({});
  const [optimisticAgents, setOptimisticAgents] = useState<Set<string>>(() => new Set());
  const toolTimelinesRef = useLatestRef(toolTimelines);
  const thinkingTimelinesRef = useLatestRef(thinkingTimelines);
  const ttlTimersRef = useRef(new Map<string, number>());

  const dropOptimistic = useCallback((key: string) => {
    setOptimisticAgents((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const clearTtl = useCallback((key: string) => {
    window.clearTimeout(ttlTimersRef.current.get(key));
    ttlTimersRef.current.delete(key);
  }, []);

  const armTtl = useCallback((key: string, status: MemberStatus) => {
    clearTtl(key);
    const ms = PRESENCE_TTL_MS[status];
    if (ms === undefined) return;
    ttlTimersRef.current.set(key, window.setTimeout(() => {
      ttlTimersRef.current.delete(key);
      setPresence((prev) => (prev[key] === status ? omitKey(prev, key) : prev));
      setActivity((prev) => omitKey(prev, key));
      setToolTimelines((prev) => omitKey(prev, key));
      setThinkingTimelines((prev) => omitKey(prev, key));
    }, ms));
  }, [clearTtl]);

  const applyStatus = useCallback((key: string, status: MemberStatus, act?: AgentActivity) => {
    setPresence((prev) => (prev[key] === status ? prev : { ...prev, [key]: status }));
    setActivity((prev) => (act ? { ...prev, [key]: act } : omitKey(prev, key)));
    const thought = act?.kind === "thinking" ? act.label?.trim() : undefined;
    if (thought) {
      setThinkingTimelines((prev) => {
        const cur = prev[key] ?? [];
        const last = cur.at(-1);
        if (last?.status !== "running") {
          return { ...prev, [key]: [...cur, { id: (traceSeq += 1), text: thought, status: "running" }] };
        }
        const text = stitchThinkingTail(last.text, thought);
        return text === last.text ? prev : { ...prev, [key]: cur.with(-1, { ...last, text }) };
      });
    }
    if (act?.kind === "tool" || act?.kind === "tool_done") {
      setThinkingTimelines((prev) => {
        const cur = prev[key];
        const last = cur?.at(-1);
        return cur && last?.status === "running" ? { ...prev, [key]: cur.with(-1, { ...last, status: "done" }) } : prev;
      });
      setToolTimelines((prev) => {
        const cur = prev[key] ?? [];
        if (act.kind === "tool") {
          const tool = act.tool ?? "";
          const last = cur.at(-1);
          if (last?.status !== "running" || last.tool !== tool) {
            return { ...prev, [key]: [...cur, { id: (traceSeq += 1), tool, label: act.label, status: "running" }] };
          }
          return !act.label || act.label === last.label
            ? prev
            : { ...prev, [key]: cur.with(-1, { ...last, label: act.label }) };
        }
        const idx = cur.findLastIndex((s) => s.status === "running");
        const done = cur[idx];
        if (!done) return prev;
        // A done label is usually the bare tool name; keep the start's command unless only the done event has detail.
        const hasDetail = (label?: string) => Boolean(label && label !== done.tool);
        return {
          ...prev,
          [key]: cur.with(idx, {
            ...done,
            status: act.ok === false ? "error" : "done",
            duration_ms: act.duration_ms,
            label: hasDetail(done.label) ? done.label : hasDetail(act.label) ? act.label : (done.label ?? act.label),
          }),
        };
      });
    }
    armTtl(key, status);
  }, [armTtl]);

  const clearStatus = useCallback((key: string) => {
    clearTtl(key);
    setPresence((prev) => omitKey(prev, key));
    setActivity((prev) => omitKey(prev, key));
    setToolTimelines((prev) => omitKey(prev, key));
    setThinkingTimelines((prev) => omitKey(prev, key));
    dropOptimistic(key);
  }, [clearTtl, dropOptimistic]);

  const finalizeAgentTraces = useCallback((agentId: string, postId: number) => {
    const key = memberKey("agent", agentId);
    const toolSteps = toolTimelinesRef.current[key];
    const thinkingSteps = thinkingTimelinesRef.current[key];
    if (postId > 0 && toolSteps?.length) {
      setFinishedToolTraces((prev) => (prev[postId] ? prev : { ...prev, [postId]: toolSteps }));
    }
    if (postId > 0 && thinkingSteps?.length) {
      const frozen = thinkingSteps.map((s) => (s.status === "running" ? { ...s, status: "done" as const } : s));
      setFinishedThinkingTraces((prev) => (prev[postId] ? prev : { ...prev, [postId]: frozen }));
    }
    clearStatus(key);
  }, [clearStatus, toolTimelinesRef, thinkingTimelinesRef]);

  const markAgentGenerating = useCallback((agentId: string) => {
    const key = memberKey("agent", agentId);
    applyStatus(key, "generating");
    setOptimisticAgents((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, [applyStatus]);

  useEffect(() => {
    const postsKey = queryKeys.mm.channelPosts(channelId, 50, 0);
    const ttlTimers = ttlTimersRef.current;
    const pendingPostUpdates = new Map<number, MmChannelPost>();
    let pinnedChanged = false;
    let flushTimer: number | undefined;
    let reconnected = false;

    const flushPostUpdates = () => {
      flushTimer = undefined;
      if (pendingPostUpdates.size === 0) return;
      const patches = [...pendingPostUpdates.values()];
      pendingPostUpdates.clear();
      const invalidatePinned = pinnedChanged;
      pinnedChanged = false;
      qc.setQueryData<MmPostListPayload>(postsKey, (prev) => {
        if (!prev) {
          const fresh = patches.filter((p) => p.post_id > 0);
          return fresh.length ? { posts: fresh, total: fresh.length, limit: 50, offset: 0 } : prev;
        }
        let next = prev.posts;
        let delta = 0;
        for (const patch of patches) {
          if (patch.agent_id) {
            const kept = next.filter((p) => !(p.post_id < 0 && p.status === "streaming" && p.agent_id === patch.agent_id));
            delta -= next.length - kept.length;
            if (kept.length !== next.length) next = kept;
          }
          const idx = next.findIndex((p) => p.post_id === patch.post_id);
          const existing = next[idx];
          if (!existing) {
            if (patch.post_id >= 0) {
              next = [patch, ...next];
              delta += 1;
            }
          } else if (versionOf(patch) >= versionOf(existing)) {
            next = next.with(idx, { ...existing, ...patch });
          }
        }
        return next === prev.posts ? prev : { ...prev, posts: next, total: Math.max(0, prev.total + delta) };
      });
      if (invalidatePinned) void qc.invalidateQueries({ queryKey: queryKeys.mm.channelPinnedPosts(channelId) });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") flushPostUpdates();
    };
    document.addEventListener("visibilitychange", onVisible);

    const conn = openSseStream(`/api/human/mm/channels/${encodeURIComponent(channelId)}/events`, (raw) => {
      const evt = raw as ServerEvent;
      if (evt.type === "post.created" || evt.type === "post.updated") {
        const post = evt.data;
        // Drafts and rejected posts are owner-only, but the bus fans out to everyone: let the GET decide.
        if (post.status === "draft" || post.status === "rejected") {
          void qc.invalidateQueries({ queryKey: postsKey });
          return;
        }
        if (evt.type === "post.created") {
          qc.setQueryData<MmPostListPayload>(postsKey, (prev) => {
            if (!prev) return { posts: [post], total: 1, limit: 50, offset: 0 };
            const optimisticIdx = post.client_msg_uuid
              ? prev.posts.findIndex((p) => p.client_msg_uuid === post.client_msg_uuid && p.post_id < 0)
              : -1;
            const idx = optimisticIdx >= 0 ? optimisticIdx : prev.posts.findIndex((p) => p.post_id === post.post_id);
            const existing = prev.posts[idx];
            if (existing) {
              if (optimisticIdx < 0 && versionOf(post) < versionOf(existing)) return prev;
              return { ...prev, posts: prev.posts.with(idx, { ...existing, ...post }) };
            }
            const kept = prev.posts.filter(
              (p) => !(post.agent_id && p.post_id < 0 && p.status === "streaming" && p.agent_id === post.agent_id),
            );
            return { ...prev, posts: [post, ...kept], total: prev.total + 1 - (prev.posts.length - kept.length) };
          });
          if (post.files?.length) void qc.invalidateQueries({ queryKey: channelFileListPrefix(channelId) });
        } else {
          const cached = qc.getQueryData<MmPostListPayload>(postsKey)?.posts.find((p) => p.post_id === post.post_id);
          if (cached && (cached.pinned_at != null) !== (post.pinned_at != null)) pinnedChanged = true;
          const pending = pendingPostUpdates.get(post.post_id);
          if (!pending || versionOf(post) >= versionOf(pending)) pendingPostUpdates.set(post.post_id, post);
          flushTimer = flushTimer ?? window.setTimeout(flushPostUpdates, FLUSH_DELAY_MS);
        }
        if (post.agent_id && post.status === "published") finalizeAgentTraces(post.agent_id, post.post_id);
        if (URL_RE.test(post.message)) void qc.invalidateQueries({ queryKey: channelLinksQueryKey(channelId) });
      } else if (evt.type === "post.deleted") {
        qc.setQueryData<MmPostListPayload>(postsKey, (prev) => {
          const posts = prev?.posts.filter((p) => p.post_id !== evt.data.post_id);
          return prev && posts && posts.length !== prev.posts.length ? { ...prev, posts, total: prev.total - 1 } : prev;
        });
        void qc.invalidateQueries({ queryKey: queryKeys.mm.channelPinnedPosts(channelId) });
        void qc.invalidateQueries({ queryKey: channelFileListPrefix(channelId) });
        void qc.invalidateQueries({ queryKey: channelLinksQueryKey(channelId) });
      } else if (evt.type === "member.status") {
        const key = memberKey(evt.data.member_kind, evt.data.member_id);
        applyStatus(key, evt.data.status, evt.data.activity);
        if (evt.data.member_kind === "agent") dropOptimistic(key);
      } else if (evt.type === "presence.snapshot") {
        const snap: PresenceMap = {};
        const actSnap: Record<string, AgentActivity> = {};
        for (const timer of ttlTimersRef.current.values()) window.clearTimeout(timer);
        ttlTimersRef.current.clear();
        for (const m of evt.data.members) {
          const key = memberKey(m.member_kind, m.member_id);
          snap[key] = m.status;
          if (m.activity) actSnap[key] = m.activity;
          armTtl(key, m.status);
        }
        setPresence(snap);
        setActivity(actSnap);
        setOptimisticAgents((prev) => (prev.size === 0 ? prev : new Set()));
        // The bus has no replay: every snapshot after the first marks a reconnect, so refetch what was missed.
        if (reconnected) void qc.invalidateQueries({ queryKey: postsKey });
        reconnected = true;
      } else if (evt.type === "user.status") {
        updateUserPresence([{
          humanId: evt.data.human_id,
          status: evt.data.status,
          lastSeenAt: evt.data.last_seen_at,
          lastSeenLabel: evt.data.last_seen_label ?? null,
        }]);
      } else if (evt.type === "agent.status") {
        updateAgentPresence([{ agentId: evt.data.agent_id, lastAliveAt: evt.data.last_alive_at }]);
      } else if (evt.type === "member.read") {
        const { human_id, agent_id, last_read_post_id } = evt.data;
        const advances = (m: MmChannelMember) =>
          (human_id != null ? m.human_id === human_id : agent_id != null && m.agent_id === agent_id)
          && last_read_post_id > (m.last_read_post_id ?? 0);
        qc.setQueryData<{ members: MmChannelMember[]; total: number }>(queryKeys.mm.channelMembers(channelId), (prev) =>
          prev?.members.some(advances)
            ? { ...prev, members: prev.members.map((m) => (advances(m) ? { ...m, last_read_post_id } : m)) }
            : prev,
        );
      } else if (evt.type === "channel.event") {
        const event = evt.data;
        qc.setQueryData<MmChannelEventListPayload>(queryKeys.mm.channelEvents(channelId, 100), (prev) => {
          if (!prev) return { events: [event], total: 1 };
          if (prev.events.some((e) => e.event_id === event.event_id)) return prev;
          return { events: [event, ...prev.events], total: prev.total + 1 };
        });
        void qc.invalidateQueries({ queryKey: queryKeys.mm.channelMembers(channelId) });
      }
    });

    return () => {
      conn.close();
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(flushTimer);
      for (const timer of ttlTimers.values()) window.clearTimeout(timer);
      ttlTimers.clear();
    };
  }, [channelId, qc, applyStatus, finalizeAgentTraces, armTtl, dropOptimistic]);

  return {
    presence,
    activity,
    toolTimelines,
    thinkingTimelines,
    finishedToolTraces,
    finishedThinkingTraces,
    optimisticAgents,
    markAgentGenerating,
  };
}

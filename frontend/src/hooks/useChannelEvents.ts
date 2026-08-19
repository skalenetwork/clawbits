import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openSseStream } from "@/lib/sse";
import { queryKeys } from "@/lib/queryKeys";
import {
  channelFileListPrefix,
  channelLinksQueryKey,
} from "@/hooks/useChannelFileList";
import { parseUtcTimestamp } from "@/lib/formatting";
import { stitchThinkingTail } from "@/lib/thinkingStitch";
import { useAgentPresence } from "@/hooks/useAgentPresence";
import { useUserPresence } from "@/hooks/useUserPresence";
import type {
  AgentLivenessStatus,
  GlobalUserStatus,
  MmChannelEvent,
  MmChannelEventListPayload,
  MmChannelMember,
  MmChannelPost,
} from "@/lib/api";

// Status values the backend may publish for a member.
export type MemberStatus =
  | "online"
  | "idle"
  | "typing"
  | "generating"
  | "offline";

// Map key -> "agent:<id>" | "human:<id>".
export type PresenceMap = Record<string, MemberStatus>;

// Agent-reported mid-turn detail riding member.status (thinking snippet /
// tool label). Ephemeral: expires with the presence entry's TTL, replaced
// by the next status update, never persisted. Labels are sanitized by the
// plugin in-VM; render as plain text only.
export interface AgentActivity {
  kind: "generating" | "thinking" | "tool" | "tool_done";
  label?: string;
  tool?: string;
  ok?: boolean;
  duration_ms?: number;
}

// Same "agent:<id>" keys as PresenceMap; entries exist only while an agent
// has a live activity detail.
export type ActivityMap = Record<string, AgentActivity>;

// One entry per tool call an agent makes during the CURRENT turn. Unlike
// ``AgentActivity`` (single-slot, latest-wins), this accumulates the ordered
// sequence so the UI can show every step and let the reader unfold them —
// still ephemeral (cleared when the turn ends), never persisted on the post.
export interface ToolStep {
  /** Stable id for React keys / dedupe. */
  id: number;
  /** Raw self-reported tool name (drives the icon+verb via toolPresentation). */
  tool: string;
  /** Agent-reported detail — the command / query / input. Kept once captured. */
  label?: string;
  status: "running" | "done" | "error";
  duration_ms?: number;
}
export type ToolTimelineMap = Record<string, ToolStep[]>;

// One entry per distinct reasoning SEGMENT an agent produces during the current
// turn. The plugin sends the live thinking text as a rolling, sanitized *tail*
// (~1/s, latest-wins) — not discrete deltas — so consecutive updates within one
// reasoning burst overlap. We coalesce them: a run of consecutive ``thinking``
// updates collapses to its newest tail (one segment), and a tool call closes
// the open segment so the agent's next burst starts a fresh one. The result is
// one readable line per reasoning burst — the same shape as ``ToolStep`` and,
// like it, purely ephemeral (cleared when the turn ends), never persisted.
export interface ThinkingStep {
  /** Stable id for React keys. */
  id: number;
  /** Sanitized reasoning tail for this segment (the newest one captured). */
  text: string;
  /** ``running`` = the still-open current burst (drives the live shimmer);
   *  ``done`` = a closed earlier burst. */
  status: "running" | "done";
}
export type ThinkingTimelineMap = Record<string, ThinkingStep[]>;

// ONE monotonic id source for BOTH tool steps and reasoning segments (module
// scope so ids stay unique across remounts within a session). Because the two
// kinds draw from the same counter, ``id`` is also a true CHRONOLOGICAL key:
// merging the two timelines and sorting by id reconstructs the turn in the
// order it actually happened (thought -> ran -> failed -> reconsidered). That
// ordering is what TurnTrace renders; keep this single counter.
let traceSeq = 0;

// Client-side TTL for ephemeral statuses, mirroring STATUS_TTL_SECONDS in
// clawbits/realtime/bus.py. Redis HEXPIRE silently drops the field after
// the same window — no broadcast fires when that happens, so we converge
// the visible state by self-clearing locally. Anything not listed here
// is sticky and stays until an explicit overwrite arrives.
const PRESENCE_TTL_MS: Partial<Record<MemberStatus, number>> = {
  typing: 6_000,
  generating: 15_000,
};

// Cheap "does this message body contain a link" test — gates Links-tab
// invalidation so plain text posts don't refetch it.
const URL_RE = /https?:\/\//i;

type ServerEvent =
  | { type: "post.created"; channel_id: string; data: MmChannelPost }
  | { type: "post.updated"; channel_id: string; data: MmChannelPost }
  | { type: "post.deleted"; channel_id: string; data: { post_id: number } }
  | {
      type: "member.status";
      channel_id: string;
      data: {
        member_kind: string;
        member_id: string;
        status: MemberStatus;
        activity?: AgentActivity;
      };
    }
  | {
      type: "presence.snapshot";
      channel_id: string;
      data: {
        members: {
          member_kind: string;
          member_id: string;
          status: MemberStatus;
          activity?: AgentActivity;
        }[];
      };
    }
  | {
      type: "user.status";
      channel_id: string;
      data: {
        human_id: number;
        status: GlobalUserStatus;
        last_seen_at: string | null;
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
  | {
      type: "member.read";
      channel_id: string;
      data: { human_id: number; last_read_post_id: number };
    }
  | { type: "channel.event"; channel_id: string; data: MmChannelEvent };

export function memberKey(kind: string, id: string | number): string {
  return `${kind}:${String(id)}`;
}

// Monotonic per-post version, used to reject stale / duplicate /
// out-of-order SSE patches. The server bumps ``updated_at`` on every
// streaming patch, finalise, and edit; ``created_at`` is the floor and
// ``edited_at`` is folded in too. A patch is applied only when its version
// is >= the cached post's, so a finalized ("published", full-content) post
// can never be regressed back to an earlier streaming/empty state by a
// late event.
function tsMs(s: string | null | undefined): number {
  if (!s) return 0;
  const ms = parseUtcTimestamp(s).getTime();
  return Number.isFinite(ms) ? ms : 0;
}
function versionOf(p: MmChannelPost): number {
  return Math.max(tsMs(p.created_at), tsMs(p.updated_at), tsMs(p.edited_at));
}

/**
 * Subscribe to SSE events for a channel. Keeps the channel's posts cache
 * in sync via react-query's `setQueryData`, and returns a realtime
 * presence map for rendering statuses.
 */
export function useChannelEvents(
  channelId: string | null | undefined,
): {
  presence: PresenceMap;
  activity: ActivityMap;
  toolTimelines: ToolTimelineMap;
  /** Ordered per-agent reasoning segments for the current turn (same keys as
   *  ``activity``); feeds the live thinking-timeline card. */
  thinkingTimelines: ThinkingTimelineMap;
  /** Finished per-post tool traces (post_id → steps), snapshotted at finalize so
   *  the tool-timeline card persists on the published reply. Session-scoped. */
  finishedToolTraces: Record<number, ToolStep[]>;
  /** Finished per-post reasoning traces (post_id → segments), snapshotted at
   *  finalize so the thinking-timeline card persists on the published reply.
   *  Session-scoped (client only — never sent to / stored on the server). */
  finishedThinkingTraces: Record<number, ThinkingStep[]>;
  /** Agent keys ("agent:<id>") whose generating state is still purely optimistic
   *  (seeded on send, not yet confirmed by a real server signal). */
  optimisticAgents: Set<string>;
  connected: boolean;
  markAgentGenerating: (agentId: string) => void;
} {
  const qc = useQueryClient();
  const userPresence = useUserPresence();
  const userPresenceRef = useRef(userPresence);
  userPresenceRef.current = userPresence;
  const agentPresence = useAgentPresence();
  const agentPresenceRef = useRef(agentPresence);
  agentPresenceRef.current = agentPresence;
  const [presence, setPresence] = useState<PresenceMap>({});
  const [activity, setActivity] = useState<ActivityMap>({});
  const [toolTimelines, setToolTimelines] = useState<ToolTimelineMap>({});
  // Ordered per-agent reasoning segments for the current turn — the thinking
  // counterpart of ``toolTimelines`` (see ThinkingStep). Same TTL/lifecycle.
  const [thinkingTimelines, setThinkingTimelines] = useState<ThinkingTimelineMap>({});
  // Per-turn tool traces snapshotted onto the FINISHED post (keyed by post_id)
  // when a reply finalises, so the tool-timeline card survives on the published
  // message (collapsed, still unfoldable) instead of vanishing with the
  // ephemeral agent-keyed timeline. Session-scoped (client only — not yet
  // persisted server-side), reset on channel switch.
  const [finishedToolTraces, setFinishedToolTraces] = useState<Record<number, ToolStep[]>>({});
  // Same, for reasoning segments — persists the thinking-timeline card on the
  // published reply (page-only; never sent to the server).
  const [finishedThinkingTraces, setFinishedThinkingTraces] = useState<Record<number, ThinkingStep[]>>({});
  // Live mirror of the agent-keyed timelines so the publish handler can read the
  // just-completed trace synchronously (SSE-handler closures can't see current
  // state). Updated in an effect — never during render.
  const toolTimelinesRef = useRef(toolTimelines);
  useEffect(() => { toolTimelinesRef.current = toolTimelines; }, [toolTimelines]);
  const thinkingTimelinesRef = useRef(thinkingTimelines);
  useEffect(() => { thinkingTimelinesRef.current = thinkingTimelines; }, [thinkingTimelines]);
  // Agent keys whose "generating" is still purely optimistic — seeded by
  // ``markAgentGenerating`` on send and cleared the instant a real server
  // signal for that agent arrives. Drives the distinct "warming up" pre-init
  // label so "just sent, agent hasn't woken up" reads apart from "thinking".
  const [optimisticAgents, setOptimisticAgents] = useState<Set<string>>(() => new Set());
  const [connected, setConnected] = useState(false);

  const dropOptimistic = useCallback((key: string) => {
    setOptimisticAgents((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // Per-key auto-clear timers for ephemeral statuses (typing/generating),
  // lifted to the hook body so the SSE handler AND the optimistic
  // ``markAgentGenerating`` seed share one timer set. The backend's Redis
  // HEXPIRE drops a stale field after its TTL but never broadcasts the
  // removal — so we converge the visible state by self-clearing on the
  // same window. Anything not in PRESENCE_TTL_MS is sticky until overwrite.
  const ttlTimersRef = useRef(new Map<string, number>());
  const clearTtl = useCallback((key: string) => {
    const handle = ttlTimersRef.current.get(key);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      ttlTimersRef.current.delete(key);
    }
  }, []);
  const armTtl = useCallback((key: string, status: MemberStatus) => {
    clearTtl(key);
    const ms = PRESENCE_TTL_MS[status];
    if (ms === undefined) return;
    const handle = window.setTimeout(() => {
      ttlTimersRef.current.delete(key);
      setPresence((prev) => {
        // Only drop if the visible status is still the one we armed — a
        // fresh broadcast may have replaced it with something sticky.
        if (prev[key] !== status) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      // The activity detail + accumulated tool timeline ride the same TTL as
      // their status entry.
      setActivity((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setToolTimelines((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setThinkingTimelines((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, ms);
    ttlTimersRef.current.set(key, handle);
  }, [clearTtl]);
  const applyStatus = useCallback(
    (key: string, status: MemberStatus, act?: AgentActivity) => {
      setPresence((prev) => (prev[key] === status ? prev : { ...prev, [key]: status }));
      // Latest-wins: a status update WITHOUT activity clears any stale
      // label (e.g. the turn-start "generating" replacing last turn's tool
      // line), one WITH activity replaces it.
      setActivity((prev) => {
        if (act) return { ...prev, [key]: act };
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      // Accumulate the ordered reasoning timeline. A ``thinking`` update carries
      // the newest tail of the CURRENT burst (rolling, latest-wins) — so we keep
      // updating the open segment in place, and only start a new segment once a
      // tool call has closed the previous one (handled in the tool block below).
      if (act && act.kind === "thinking") {
        const text = act.label?.trim();
        if (text) {
          setThinkingTimelines((prev) => {
            const cur = prev[key] ?? [];
            const last = cur[cur.length - 1];
            if (last && last.status === "running") {
              // Same burst still streaming → weld the new tail onto the text
              // reconstructed so far (recovers the earlier reasoning a plain
              // latest-wins would drop). The live status line keeps using the
              // raw short tail from ActivityMap — only this unfoldable copy grows.
              const stitched = stitchThinkingTail(last.text, text);
              if (stitched === last.text) return prev;
              const next = cur.slice();
              next[next.length - 1] = { ...last, text: stitched };
              return { ...prev, [key]: next };
            }
            const step: ThinkingStep = { id: (traceSeq += 1), text, status: "running" };
            return { ...prev, [key]: [...cur, step] };
          });
        }
      }
      // Accumulate the ordered tool timeline for this turn. We do it HERE, at the
      // event source, so every ``tool`` / ``tool_done`` transition is captured
      // before the single-slot ActivityMap coalesces them. generating leaves the
      // timeline untouched.
      if (act && (act.kind === "tool" || act.kind === "tool_done")) {
        // A tool call ends the current reasoning burst, so the agent's next
        // ``thinking`` update opens a fresh segment rather than overwriting this
        // one's captured tail.
        setThinkingTimelines((prev) => {
          const cur = prev[key];
          if (!cur || cur.length === 0) return prev;
          const last = cur[cur.length - 1];
          if (!last || last.status !== "running") return prev;
          const next = cur.slice();
          next[next.length - 1] = { ...last, status: "done" };
          return { ...prev, [key]: next };
        });
        setToolTimelines((prev) => {
          const cur = prev[key] ?? [];
          if (act.kind === "tool") {
            const last = cur[cur.length - 1];
            const toolName = act.tool ?? "";
            // Continuation of the still-running step (label/command tick) →
            // update in place; otherwise it's a new step.
            if (last && last.status === "running" && last.tool === toolName) {
              if (!act.label || act.label === last.label) return prev;
              const next = cur.slice();
              next[next.length - 1] = { ...last, label: act.label };
              return { ...prev, [key]: next };
            }
            const step: ToolStep = {
              id: (traceSeq += 1),
              tool: toolName,
              label: act.label,
              status: "running",
            };
            return { ...prev, [key]: [...cur, step] };
          }
          // tool_done → finalise the most recent still-running step.
          let idx = -1;
          for (let i = cur.length - 1; i >= 0; i--) {
            if (cur[i]?.status === "running") { idx = i; break; }
          }
          if (idx === -1) return prev;
          const next = cur.slice();
          const done = next[idx];
          if (done) {
            // Keep the COMMAND captured at tool-start: the tool_done event's
            // label is USUALLY only the tool NAME, and using it would blank the
            // command the instant the step finishes (the "shows then vanishes"
            // bug). But a done label carrying DETAIL (≠ the bare tool name) is
            // worth adopting when the start had none — the Codex harness only
            // learns a web_search's query on completion, so that event is the
            // first thing that can say what was searched.
            const hasDetail = (l?: string) => Boolean(l && l !== done.tool);
            next[idx] = {
              ...done,
              status: act.ok === false ? "error" : "done",
              duration_ms: act.duration_ms,
              label: hasDetail(done.label)
                ? done.label
                : hasDetail(act.label)
                  ? act.label
                  : (done.label ?? act.label),
            };
          }
          return { ...prev, [key]: next };
        });
      }
      armTtl(key, status);
    },
    [armTtl],
  );
  // Drop an agent's accumulated tool timeline — the turn is over (post
  // finalised, status flipped to idle, or the presence entry TTL'd out).
  const clearToolTimeline = useCallback((key: string) => {
    setToolTimelines((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);
  const clearThinkingTimeline = useCallback((key: string) => {
    setThinkingTimelines((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);
  const clearStatus = useCallback((key: string) => {
    clearTtl(key);
    setPresence((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setActivity((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    clearToolTimeline(key);
    clearThinkingTimeline(key);
    dropOptimistic(key);
  }, [clearTtl, clearToolTimeline, clearThinkingTimeline, dropOptimistic]);
  // A reply finalised: snapshot the agent's just-completed tool + reasoning
  // traces onto the published post (so both cards persist there, collapsed +
  // unfoldable) before clearing the ephemeral agent-keyed state.
  const finalizeAgentTraces = useCallback(
    (agentId: string, postId: number) => {
      const key = memberKey("agent", agentId);
      const toolSteps = toolTimelinesRef.current[key];
      if (postId > 0 && toolSteps && toolSteps.length > 0) {
        setFinishedToolTraces((prev) => (prev[postId] ? prev : { ...prev, [postId]: toolSteps }));
      }
      const thinkingSteps = thinkingTimelinesRef.current[key];
      if (postId > 0 && thinkingSteps && thinkingSteps.length > 0) {
        // Freeze the trailing burst: nothing is "running" on a finished reply
        // (the agent has stopped), so the persisted card never shimmers.
        const frozen = thinkingSteps.map((s) =>
          s.status === "running" ? { ...s, status: "done" as const } : s,
        );
        setFinishedThinkingTraces((prev) => (prev[postId] ? prev : { ...prev, [postId]: frozen }));
      }
      clearStatus(key);
    },
    [clearStatus],
  );
  // Optimistically mark an agent "generating" the instant the user sends it
  // a message — bridges the gap until the agent's own heartbeat arrives,
  // and self-expires via the generating TTL if the agent never responds,
  // so a non-reply can't strand the indicator (the old fabricated-
  // placeholder failure mode).
  const markAgentGenerating = useCallback((agentId: string) => {
    const key = memberKey("agent", agentId);
    applyStatus(key, "generating");
    setOptimisticAgents((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, [applyStatus]);

  useEffect(() => {
    if (!channelId) return;
    setPresence({});
    setActivity({});
    setToolTimelines({});
    setThinkingTimelines({});
    setFinishedToolTraces({});
    setFinishedThinkingTraces({});
    setOptimisticAgents(new Set());
    setConnected(false);
    // New channel — drop any TTL timers armed for the previous one.
    for (const handle of ttlTimersRef.current.values()) window.clearTimeout(handle);
    ttlTimersRef.current.clear();

    // Pending ``post.updated`` patches, keyed by post_id. SSE delivers
    // token-by-token during streaming replies (20-30 events/sec for a
    // fast agent) and writing each one to React Query immediately
    // re-renders the whole channel page + virtualizer. Coalescing into
    // a single setQueryData per animation frame caps the re-render
    // rate at the display refresh rate (~60 Hz) and lets multiple
    // patches for the same post collapse into one merge. Cleared on
    // channel switch via the effect's cleanup.
    const pendingPostUpdates = new Map<number, MmChannelPost>();
    let pinnedChangedInFlush = false;
    // Coalesce + flush via a short timer rather than requestAnimationFrame.
    // rAF is paused/throttled in background tabs, which stranded streamed
    // ``post.updated`` patches in ``pendingPostUpdates`` until the tab was
    // refocused — the "live updates delayed by 5-20s" symptom. A ~32ms timer
    // still collapses token bursts (many patches per post → one merge) but
    // keeps flushing when hidden, and we additionally flush on
    // ``visibilitychange`` so a backgrounded burst lands immediately on
    // return (background timers are clamped to ~1Hz).
    const FLUSH_DELAY_MS = 32;
    let updateFlushTimer: number | null = null;
    const flushPostUpdates = () => {
      updateFlushTimer = null;
      if (pendingPostUpdates.size === 0) return;
      const patches = Array.from(pendingPostUpdates.values());
      pendingPostUpdates.clear();
      const localPinnedChanged = pinnedChangedInFlush;
      pinnedChangedInFlush = false;
      qc.setQueryData<{
        posts: MmChannelPost[];
        total: number;
        limit: number;
        offset: number;
      }>(queryKeys.mm.channelPosts(channelId, 50, 0), (prev) => {
        if (!prev) {
          // No cached page yet — surface any real post immediately so a
          // dropped post.created doesn't hide a live reply. Ordering is
          // reconciled by the initial load / poll moments later.
          const fresh = patches.filter((p) => p.post_id > 0);
          if (fresh.length === 0) return prev;
          return { posts: fresh, total: fresh.length, limit: 50, offset: 0 };
        }
        let next = prev.posts;
        let mutated = false;
        let inserted = 0;
        let removed = 0;
        for (const patch of patches) {
          if (patch.agent_id) {
            const withoutPlaceholder = next.filter(
              (p) => !(p.post_id < 0 && p.status === "streaming" && p.agent_id === patch.agent_id),
            );
            if (withoutPlaceholder.length !== next.length) {
              removed += next.length - withoutPlaceholder.length;
              next = withoutPlaceholder;
              mutated = true;
            }
          }
          const idx = next.findIndex((p) => p.post_id === patch.post_id);
          if (idx < 0) {
            // post.created was dropped (lossy bus) or arrived out of order.
            // Upsert the real post regardless of status — discarding a
            // terminal ``published`` update here was a stuck-loading cause.
            if (patch.post_id < 0) continue;
            if (!mutated) { next = next.slice(); mutated = true; }
            next.unshift(patch);
            inserted += 1;
            continue;
          }
          const existing = next[idx];
          if (!existing) continue;
          // Monotonic guard: never let a stale / duplicate / out-of-order
          // patch regress a post to an earlier (e.g. streaming/empty) state.
          if (versionOf(patch) < versionOf(existing)) continue;
          if (!mutated) { next = next.slice(); mutated = true; }
          next[idx] = { ...existing, ...patch };
        }
        if (!mutated) return prev;
        return { ...prev, posts: next, total: Math.max(0, prev.total + inserted - removed) };
      });
      if (localPinnedChanged) {
        void qc.invalidateQueries({
          queryKey: queryKeys.mm.channelPinnedPosts(channelId),
        });
      }
    };
    const scheduleUpdateFlush = () => {
      if (updateFlushTimer !== null) return;
      updateFlushTimer = window.setTimeout(flushPostUpdates, FLUSH_DELAY_MS);
    };
    const onVisibilityFlush = () => {
      if (document.visibilityState === "visible") flushPostUpdates();
    };
    document.addEventListener("visibilitychange", onVisibilityFlush);

    const url = `/api/human/mm/channels/${encodeURIComponent(channelId)}/events`;
    const conn = openSseStream(
      url,
      (raw) => {
        setConnected(true);
        const evt = raw as ServerEvent;
        // Approval-gated states (draft / rejected) are visibility-restricted
        // server-side, but the realtime bus broadcasts to every channel
        // subscriber. Treat those events as "refresh prompts" and let the
        // GET re-fetch decide who actually sees them — that endpoint runs
        // the owner check and excludes drafts for non-owners.
        const isApprovalGated =
          (evt.type === "post.created" || evt.type === "post.updated") &&
          (evt.data.status === "draft" || evt.data.status === "rejected");
        if (isApprovalGated) {
          void qc.invalidateQueries({
            queryKey: queryKeys.mm.channelPosts(channelId, 50, 0),
          });
        } else if (evt.type === "post.created") {
          qc.setQueryData<{
            posts: MmChannelPost[];
            total: number;
            limit: number;
            offset: number;
          }>(queryKeys.mm.channelPosts(channelId, 50, 0), (prev) => {
            if (!prev) {
              return { posts: [evt.data], total: 1, limit: 50, offset: 0 };
            }
            // Dedupe order: ``client_msg_uuid`` first so we can resolve
            // a sender's optimistic row (negative post_id) into the
            // server's canonical one in a single pass; ``post_id`` next
            // for the approval-publish case where the row is already
            // in the cache as a draft and just needs its status to
            // flip. Both branches merge the event payload — never
            // ignored, because approval transitions depend on it.
            const incomingUuid = evt.data.client_msg_uuid ?? null;
            const optimisticIdx = incomingUuid
              ? prev.posts.findIndex(
                  (p) => p.client_msg_uuid === incomingUuid && p.post_id < 0,
                )
              : -1;
            if (optimisticIdx >= 0) {
              const next = prev.posts.slice();
              next[optimisticIdx] = { ...next[optimisticIdx], ...evt.data };
              return { ...prev, posts: next };
            }
            const idx = prev.posts.findIndex((p) => p.post_id === evt.data.post_id);
            if (idx >= 0) {
              const existing = prev.posts[idx];
              // Monotonic guard — don't regress a newer cached post with an
              // older duplicate / out-of-order created event.
              if (existing && versionOf(evt.data) < versionOf(existing)) return prev;
              const next = prev.posts.slice();
              next[idx] = { ...existing, ...evt.data };
              return { ...prev, posts: next };
            }
            const filtered = prev.posts.filter(
              (p) => !(evt.data.agent_id && p.post_id < 0 && p.status === "streaming" && p.agent_id === evt.data.agent_id),
            );
            return {
              ...prev,
              posts: [evt.data, ...filtered],
              total: prev.total + 1 - (prev.posts.length - filtered.length),
            };
          });
          // A finished agent post is itself proof the agent stopped
          // generating — clear its indicator now rather than waiting on the
          // (lossy) member.status:online event or the TTL. Snapshot its tool
          // trace onto the post first so the card persists on the finished reply.
          if (evt.data.agent_id && evt.data.status === "published") {
            finalizeAgentTraces(evt.data.agent_id, evt.data.post_id);
          }
          // Keep the Attachments sidebar live: a new post may carry files
          // (Media/Files tabs) and/or URLs (Links tab). invalidateQueries
          // only refetches *mounted* queries, so this is a no-op when the
          // sidebar is closed.
          if (evt.data.files && evt.data.files.length > 0) {
            void qc.invalidateQueries({ queryKey: channelFileListPrefix(channelId) });
          }
          if (URL_RE.test(evt.data.message)) {
            void qc.invalidateQueries({ queryKey: channelLinksQueryKey(channelId) });
          }
        } else if (evt.type === "post.updated") {
          // Buffer + coalesce. Successive patches for the same post
          // collapse into the latest one (full post payload, not a
          // diff). Pinned-state changes have to invalidate the pinned-
          // list query — detect across the *buffer*, not the cache,
          // so we don't lose the signal when multiple patches for the
          // same post toggle pinned within a single frame.
          const incoming = evt.data;
          const cached = qc.getQueryData<{
            posts: MmChannelPost[];
            total: number;
            limit: number;
            offset: number;
          }>(queryKeys.mm.channelPosts(channelId, 50, 0));
          const existingInCache = cached?.posts.find((p) => p.post_id === incoming.post_id);
          if (existingInCache) {
            const wasPinned = existingInCache.pinned_at != null;
            const nowPinned = incoming.pinned_at != null;
            if (wasPinned !== nowPinned) pinnedChangedInFlush = true;
          }
          // Newest-wins coalescing: if an out-of-order older patch lands in
          // the same window as a newer one, keep the newer.
          const pending = pendingPostUpdates.get(incoming.post_id);
          if (!pending || versionOf(incoming) >= versionOf(pending)) {
            pendingPostUpdates.set(incoming.post_id, incoming);
          }
          scheduleUpdateFlush();
          // Finished agent post → snapshot its tool trace + clear its generating
          // indicator (see the post.created branch; mirror it here for the
          // patch-to-publish finalise path).
          if (incoming.agent_id && incoming.status === "published") {
            finalizeAgentTraces(incoming.agent_id, incoming.post_id);
          }
          // An edit can add/remove a URL — refresh the Links tab (files
          // are immutable post-create, so the Media/Files tabs are not).
          if (URL_RE.test(incoming.message)) {
            void qc.invalidateQueries({ queryKey: channelLinksQueryKey(channelId) });
          }
        } else if (evt.type === "post.deleted") {
          // Remove the post from the channel cache. Replies that quoted
          // it remain (server already detached them) but their
          // ``parent_preview`` may now be stale — invalidate so the
          // tail of any open thread refreshes.
          qc.setQueryData<{
            posts: MmChannelPost[];
            total: number;
            limit: number;
            offset: number;
          }>(queryKeys.mm.channelPosts(channelId, 50, 0), (prev) => {
            if (!prev) return prev;
            const next = prev.posts.filter((p) => p.post_id !== evt.data.post_id);
            if (next.length === prev.posts.length) return prev;
            return { ...prev, posts: next, total: prev.total - 1 };
          });
          // The deleted post may have been pinned. The pinned-list query
          // can't tell from here without looking at its own cache, so
          // invalidate unconditionally — it's a single small request.
          void qc.invalidateQueries({
            queryKey: queryKeys.mm.channelPinnedPosts(channelId),
          });
          // The deleted post may have held files or links — refresh both
          // attachment lists (mounted-only refetch).
          void qc.invalidateQueries({ queryKey: channelFileListPrefix(channelId) });
          void qc.invalidateQueries({ queryKey: channelLinksQueryKey(channelId) });
        } else if (evt.type === "member.status") {
          // Presence is the single source of truth for "who's active". The
          // agent "generating" indicator is rendered from this map (and
          // self-expires via the TTL) — there are no fabricated post rows
          // to strand, which is what fixes the false/stuck loading state.
          {
            const k = memberKey(evt.data.member_kind, evt.data.member_id);
            applyStatus(k, evt.data.status, evt.data.activity);
            // A real server signal for this agent — it's no longer purely
            // optimistic, so switch "warming up" over to the thinking labels.
            if (evt.data.member_kind === "agent") dropOptimistic(k);
          }
        } else if (evt.type === "presence.snapshot") {
          const snap: PresenceMap = {};
          const actSnap: ActivityMap = {};
          for (const m of evt.data.members) {
            snap[memberKey(m.member_kind, m.member_id)] = m.status;
            if (m.activity) actSnap[memberKey(m.member_kind, m.member_id)] = m.activity;
          }
          setPresence(snap);
          setActivity(actSnap);
          // The snapshot is authoritative real state, so nothing shown from it
          // is optimistic anymore.
          setOptimisticAgents((prev) => (prev.size === 0 ? prev : new Set()));
          // Replace timers so anything not in the snapshot is also dropped.
          for (const key of Array.from(ttlTimersRef.current.keys())) clearTtl(key);
          for (const m of evt.data.members) {
            armTtl(memberKey(m.member_kind, m.member_id), m.status);
          }
          // A snapshot is emitted on initial SSE connect and every reconnect.
          // The event bus is intentionally lossy (no replay), so refetch posts
          // here to catch any draft/publish events missed while disconnected.
          void qc.invalidateQueries({
            queryKey: queryKeys.mm.channelPosts(channelId, 50, 0),
          });
        } else if (evt.type === "user.status") {
          // Channel-scoped fan-out of a human member's global status —
          // route into the shared presence context so avatar dots
          // anywhere in the app reflect the change.
          userPresenceRef.current.set(
            evt.data.human_id,
            evt.data.status,
            evt.data.last_seen_at,
            evt.data.last_seen_label ?? null,
          );
        } else if (evt.type === "agent.status") {
          // Channel-scoped fan-out of an agent's global liveness coming
          // online — route into the shared agent presence context.
          agentPresenceRef.current.set(evt.data.agent_id, evt.data.last_alive_at);
        } else if (evt.type === "member.read") {
          // Bump the read pointer for the human who advanced. Drives
          // outgoing-message read receipts in DMs (single → double
          // check). Monotonic: never let an out-of-order event drag the
          // pointer backward.
          const { human_id, last_read_post_id } = evt.data;
          qc.setQueryData<{ members: MmChannelMember[]; total: number }>(
            queryKeys.mm.channelMembers(channelId),
            (prev) => {
              if (!prev) return prev;
              let changed = false;
              const next = prev.members.map((m) => {
                if (m.human_id !== human_id) return m;
                const current = m.last_read_post_id ?? 0;
                if (last_read_post_id <= current) return m;
                changed = true;
                return { ...m, last_read_post_id };
              });
              return changed ? { ...prev, members: next } : prev;
            },
          );
          // A membership change usually arrives alongside a
          // ``channel.event`` (handled below) describing the same
          // action, but the channel-members cache also needs to
          // reflect the new roster — invalidate so the manage-members
          // dialog and any presence-dot rendering pick the right list.
        } else if (evt.type === "channel.event") {
          // Inline channel timeline event (member.added / member.removed
          // today). Lives in a separate cache from posts; ChannelPage
          // merges both streams at render time. Prepend newest-first;
          // dedupe on event_id in case SSE replays after a reconnect.
          qc.setQueryData<MmChannelEventListPayload>(
            queryKeys.mm.channelEvents(channelId, 100),
            (prev) => {
              if (!prev) {
                return { events: [evt.data], total: 1 };
              }
              if (prev.events.some((e) => e.event_id === evt.data.event_id)) {
                return prev;
              }
              return {
                events: [evt.data, ...prev.events],
                total: prev.total + 1,
              };
            },
          );
          // The channel-member roster moves whenever an event fires.
          // Invalidate so the manage-members dialog and channel-detail
          // pane re-fetch and reflect the change without waiting for a
          // poll.
          void qc.invalidateQueries({
            queryKey: queryKeys.mm.channelMembers(channelId),
          });
        }
      },
      {
        onError: () => {
          setConnected(false);
        },
      },
    );

    return () => {
      conn.close();
      document.removeEventListener("visibilitychange", onVisibilityFlush);
      for (const handle of ttlTimersRef.current.values()) window.clearTimeout(handle);
      ttlTimersRef.current.clear();
      // Drop any pending coalesced post.updated patches on channel
      // switch — the new channel has its own cache key and these
      // patches would be misapplied (or worse, applied to a freshly-
      // mounted virtualizer mid-init).
      if (updateFlushTimer !== null) {
        window.clearTimeout(updateFlushTimer);
        updateFlushTimer = null;
      }
      pendingPostUpdates.clear();
      pinnedChangedInFlush = false;
    };
  }, [channelId, qc, applyStatus, clearStatus, finalizeAgentTraces, armTtl, clearTtl, dropOptimistic]);

  return {
    presence,
    activity,
    toolTimelines,
    thinkingTimelines,
    finishedToolTraces,
    finishedThinkingTraces,
    optimisticAgents,
    connected,
    markAgentGenerating,
  };
}

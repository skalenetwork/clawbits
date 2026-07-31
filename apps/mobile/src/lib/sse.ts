import { fetch as expoFetch } from 'expo/fetch';

import { apiBaseUrl } from '@/lib/config';

export type MmEventType =
  | 'post.created'
  | 'post.updated'
  | 'post.deleted'
  | 'member.status'
  | 'member.read'
  | 'channel.read'
  | 'channel.muted'
  | 'channel.pinned'
  | 'channel.added'
  | 'channel.removed'
  | 'channel.event'
  | 'presence.snapshot'
  | 'user.status';

export interface MemberReadEvent {
  human_id: number;
  last_read_post_id: number;
}

export interface MmEvent<T = unknown> {
  type: MmEventType;
  channel_id?: string;
  data: T;
}

export interface MemberStatusEvent {
  member_kind: 'human' | 'agent';
  member_id: string;
  status: string;
}

export interface ChannelReadEvent {
  channel_id: string;
  human_id: number;
  last_read_post_id: number;
}

export interface ChannelMutedEvent {
  channel_id: string;
  muted: boolean;
}

export interface ChannelPinnedEvent {
  channel_id: string;
  pinned: boolean;
}

export interface ChannelRemovedEvent {
  channel_id: string;
}

/** Shared lifecycle callbacks used by both stream openers. ``onOpen``
 *  fires on every successful (re)connect so callers can hook
 *  "refetch on reconnect" without diffing previous state. ``onClose``
 *  fires exactly once when this attempt ends on its own (idle-watchdog
 *  trip, network error, or the server closing the body) — NOT when the
 *  caller tears down via the returned cleanup. */
interface StreamLifecycleCallbacks {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: unknown) => void;
}

interface OpenChannelEventsOptions extends StreamLifecycleCallbacks {
  token: string;
  channelId: string;
  onEvent: (event: MmEvent) => void;
}

interface OpenUserEventsOptions extends StreamLifecycleCallbacks {
  token: string;
  onEvent: (event: MmEvent) => void;
}

export function openChannelEvents(options: OpenChannelEventsOptions): () => void {
  const { token, channelId, onEvent, ...lifecycle } = options;
  const url = `${apiBaseUrl}/api/human/mm/channels/${encodeURIComponent(channelId)}/events`;
  return openSseStream({ url, token, onEvent, ...lifecycle });
}

/** Opens the global per-user SSE stream. Carries sidebar / cross-tab
 *  events that aren't tied to whichever channel the user happens to be
 *  viewing — ``channel.added``, ``channel.removed``, ``channel.muted``,
 *  ``channel.read``, ``user.status``, plus ``post.created`` fanned for
 *  every member channel so unread badges can light up without a
 *  refetch. */
export function openUserEvents(options: OpenUserEventsOptions): () => void {
  const { token, onEvent, ...lifecycle } = options;
  const url = `${apiBaseUrl}/api/human/events`;
  return openSseStream({ url, token, onEvent, ...lifecycle });
}

interface OpenSseStreamArgs extends StreamLifecycleCallbacks {
  url: string;
  token: string;
  onEvent: (event: MmEvent) => void;
}

// Reconnect if no bytes arrive within this window. The server emits a ``: ka``
// keepalive comment every ~20s (clawbits/realtime/sse.py), so ~45s is roughly
// two missed keepalives — long enough that one late/dropped keepalive doesn't
// trip a false reconnect, short enough that a genuinely dead (half-open)
// socket is caught in seconds instead of waiting out the OS TCP timeout.
const IDLE_TIMEOUT_MS = 45_000;

/**
 * Minimal fetch-based SSE reader with a liveness watchdog — the same approach
 * the web client uses (`frontend/src/lib/sse.ts`), ported to React Native via
 * ``expo/fetch`` (which, unlike ``react-native-sse``'s XHR transport, exposes
 * the raw response body as a stream so we SEE the keepalive bytes).
 *
 * Why the watchdog matters: a half-open socket (proxy idle-drop, NAT rebind,
 * cellular radio handoff) leaves ``reader.read()`` blocked with no error and
 * no events — the "sidebar badge moves but the open chat is frozen" failure.
 * ``react-native-sse`` couldn't detect this because it never surfaced the
 * keepalive comment. Here we re-arm a timer on EVERY chunk (data frame OR
 * ``:`` comment); if it fires we abort, which ends this attempt and lets the
 * caller (``useSseConnection``) reconnect.
 *
 * This opener runs a SINGLE attempt — reconnect/backoff/foreground/network
 * handling lives in ``useSseConnection``. On a stale/errored/closed stream it
 * calls ``onClose`` so that machine schedules a reconnect; the returned
 * cleanup tears down silently (no ``onClose``).
 */
function openSseStream({
  url,
  token,
  onEvent,
  onOpen,
  onClose,
  onError,
}: OpenSseStreamArgs): () => void {
  const controller = new AbortController();
  // Plain booleans (not a literal union) so TS flow-analysis doesn't narrow
  // them to a constant across the awaits — the watchdog/teardown closures
  // mutate them out of band.
  let closed = false;
  let tornDown = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const clearWatchdog = () => {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };
  const armWatchdog = () => {
    clearWatchdog();
    if (closed) return;
    watchdog = setTimeout(() => {
      // No bytes for IDLE_TIMEOUT_MS — treat the socket as dead. Aborting
      // unblocks the pending ``reader.read()`` and drops into the catch below,
      // which calls onClose so the caller reconnects.
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };

  const finish = (err?: unknown) => {
    if (closed) return;
    closed = true;
    clearWatchdog();
    if (tornDown) return; // caller teardown — stay silent, no reconnect signal
    if (err !== undefined) onError?.(err);
    onClose?.();
  };

  void (async () => {
    try {
      const res = await expoFetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed (${String(res.status)})`);
      }
      if (closed) return;
      onOpen?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      armWatchdog();

      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        // Any bytes — a data frame OR a ``:`` keepalive comment — prove the
        // stream is alive. Re-arm before parsing.
        armWatchdog();
        buffer += decoder.decode(value, { stream: true });
        // Frames are separated by a blank line ("\n\n").
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue; // comment / keepalive
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length === 0) continue;
          try {
            onEvent(JSON.parse(dataLines.join('\n')) as MmEvent);
          } catch {
            // Malformed / non-JSON payload — ignore.
          }
        }
      }
      finish();
    } catch (err) {
      // An abort (caller teardown OR watchdog trip) is a clean close, not a
      // surfaced error; a real connect/read failure surfaces via onError.
      finish(controller.signal.aborted ? undefined : err);
    }
  })();

  return () => {
    tornDown = true;
    closed = true;
    clearWatchdog();
    controller.abort();
  };
}

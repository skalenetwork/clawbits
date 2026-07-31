import NetInfo from '@react-native-community/netinfo';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { type MmEvent } from '@/lib/sse';

export type SseStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

// Reconnect timing. Exponential backoff capped at 30s, with ±25% jitter to
// avoid thundering-herd reconnects after a server bounce. The attempt counter
// resets to zero after the connection has been stable for the stable-threshold
// window — so a flaky session doesn't ratchet up to the cap and stay there.
const RECONNECT_BASE_MS = 250;
const RECONNECT_CAP_MS = 30_000;
const RECONNECT_JITTER = 0.25;
const STABLE_RESET_MS = 30_000;

/** Lifecycle callbacks the hook hands to the stream opener. The hook owns
 *  ``onOpen``/``onClose``/``onError`` (they drive the reconnect machine) and
 *  threads the caller's ``onEvent`` through unchanged. */
export interface SseStreamCallbacks {
  onEvent: (event: MmEvent) => void;
  onOpen: () => void;
  onClose: () => void;
  onError: (error: unknown) => void;
}

interface UseSseConnectionArgs {
  /** Gate the whole machine — pass ``false`` while unauthenticated so the
   *  stream tears down and no reconnects are scheduled. */
  enabled: boolean;
  /** Opens the underlying stream with the given lifecycle callbacks and
   *  returns its teardown (e.g. wraps ``openUserEvents`` / ``openChannelEvents``
   *  with the right token + channel). MUST be stable across renders — wrap it
   *  in ``useCallback`` keyed on token/channelId — or the effect re-subscribes
   *  (and reconnects) on every render. */
  open: (callbacks: SseStreamCallbacks) => () => void;
  /** Receives every event from the live stream. Should be stable. */
  onEvent: (event: MmEvent) => void;
  /** Fires after a *reconnect* opens (not the first connect) — the caller's cue
   *  to revalidate caches for the window of events missed while disconnected. */
  onReconnect?: () => void;
  /** Status transitions, for a connection indicator. */
  onStatusChange?: (status: SseStatus) => void;
}

/**
 * Resilient SSE connection state machine, shared by the global per-user stream
 * (RealtimeProvider) and the per-channel stream (useChannelSse). Handles
 * connect → reconnect with exponential backoff + jitter, foreground/background
 * teardown via AppState, fast reconnect on the network back-online edge via
 * NetInfo, and a stable-connection backoff reset. On every *reconnect* it fires
 * ``onReconnect`` so the caller can revalidate caches for the missed gap.
 *
 * Without this, a single network blip silently kills the stream (the
 * `react-native-sse` lib tears down on the first error and never retries) — the
 * exact failure the per-channel stream used to have for live messages.
 */
export function useSseConnection({
  enabled,
  open,
  onEvent,
  onReconnect,
  onStatusChange,
}: UseSseConnectionArgs): void {
  useEffect(() => {
    if (!enabled) {
      onStatusChange?.('idle');
      return undefined;
    }

    let cleanup: (() => void) | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stableResetTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let hasBeenOpen = false;
    let isBackgrounded = false;
    let isOffline = false;
    let cancelled = false;

    const setStatus = (s: SseStatus) => onStatusChange?.(s);
    const clearReconnect = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
    const clearStableReset = () => {
      if (stableResetTimer) {
        clearTimeout(stableResetTimer);
        stableResetTimer = null;
      }
    };

    const disconnect = () => {
      clearReconnect();
      clearStableReset();
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || isBackgrounded || reconnectTimer) return;
      setStatus('reconnecting');
      // While offline, retries are guaranteed to fail — wait for NetInfo to
      // fire the back-online edge instead of burning battery on doomed attempts.
      if (isOffline) return;
      const base = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
      const jitter = base * RECONNECT_JITTER * (Math.random() * 2 - 1);
      const delay = Math.max(RECONNECT_BASE_MS, Math.round(base + jitter));
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled || isBackgrounded || cleanup) return;
      setStatus(hasBeenOpen ? 'reconnecting' : 'connecting');
      cleanup = open({
        onEvent,
        onOpen: () => {
          if (cancelled) return;
          const isReconnect = hasBeenOpen;
          hasBeenOpen = true;
          setStatus('open');
          // After a stretch of stable connection, let the next blip start
          // backoff from scratch instead of a capped-out delay.
          clearStableReset();
          stableResetTimer = setTimeout(() => {
            attempt = 0;
          }, STABLE_RESET_MS);
          if (isReconnect) onReconnect?.();
        },
        onClose: () => {
          cleanup = null;
          clearStableReset();
          if (cancelled || isBackgrounded) return;
          scheduleReconnect();
        },
        onError: () => {
          // The lib already tears down on error and calls onClose; nothing to
          // do here beyond letting onClose schedule the reconnect.
        },
      });
    };

    const appStateSub = AppState.addEventListener('change', (state) => {
      // Only a real ``background`` tears the stream down. ``inactive`` fires
      // transiently on iOS (Control Center pull, the incoming-call / banner
      // prompt, the app-switcher peek) without the app actually leaving the
      // foreground — treating it as a disconnect caused both sockets to
      // teardown + full reconnect + gap-revalidation for sub-second blips.
      if (state === 'background') {
        if (isBackgrounded) return;
        isBackgrounded = true;
        disconnect();
        setStatus('idle');
      } else if (state === 'active') {
        if (!isBackgrounded) return;
        isBackgrounded = false;
        // Reset backoff so the foreground reconnect is immediate — the prior
        // delay was for a problem that's almost certainly resolved by now.
        attempt = 0;
        connect();
      }
    });

    // React to airplane-mode / wifi-cellular flips immediately instead of
    // waiting for the exponential backoff to fire its next attempt.
    const netInfoUnsub = NetInfo.addEventListener((state) => {
      const nowOffline = state.isConnected === false;
      if (nowOffline === isOffline) return;
      isOffline = nowOffline;
      if (isOffline) {
        clearReconnect();
        return;
      }
      // Connectivity restored. If we never lost the socket, ``cleanup`` is still
      // set and ``connect`` is a no-op; otherwise reset backoff and try now.
      if (cancelled || isBackgrounded) return;
      attempt = 0;
      clearReconnect();
      if (!cleanup) connect();
    });

    connect();

    return () => {
      cancelled = true;
      appStateSub.remove();
      netInfoUnsub();
      disconnect();
    };
  }, [enabled, open, onEvent, onReconnect, onStatusChange]);
}

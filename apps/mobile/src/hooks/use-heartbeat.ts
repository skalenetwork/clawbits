import { useEffect } from 'react';
import { AppState } from 'react-native';

import { sendGlobalPresenceHeartbeat, type GlobalUserStatus } from '@/lib/api';

// Refresh cadence while in the foreground. Tuned under the backend's
// ~45s "online" Redis TTL so a single dropped beat never expires us.
const ONLINE_HEARTBEAT_MS = 30_000;

/**
 * Publishes the current user's global presence so peers see them online.
 *
 * Mobile counterpart of the web ``useHeartbeat``. The web hook keys off
 * tab visibility + pointer activity; mobile has neither, so we drive
 * status straight off ``AppState``:
 *
 *   - ``active``   → ``online``, refreshed every 30s (beats the ~45s TTL).
 *   - ``background`` → a single ``idle`` ping, then we stop. iOS suspends
 *     JS timers in the background anyway, so the interval naturally halts;
 *     the backend's longer "idle" TTL then lapses us to offline if we stay
 *     away — mirroring the web "hidden tab → idle → eventually offline".
 *   - ``inactive`` is deliberately ignored: it fires transiently (Control
 *     Center, the incoming-call banner, the app switcher peek) without the
 *     app actually leaving the foreground, so reacting to it would churn
 *     needless presence writes.
 *
 * Without this the mobile app consumes presence but never emits its own,
 * so an iOS user appears permanently OFFLINE to everyone else.
 */
export function useHeartbeat(enabled: boolean, token: string | null): void {
  useEffect(() => {
    if (!enabled || !token) return undefined;

    let interval: ReturnType<typeof setInterval> | null = null;
    const send = (status: GlobalUserStatus) => {
      void sendGlobalPresenceHeartbeat(token, status).catch(() => {});
    };
    const stop = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const startOnline = () => {
      send('online');
      if (!interval) {
        interval = setInterval(() => send('online'), ONLINE_HEARTBEAT_MS);
      }
    };

    // Announce immediately so the presence dot turns green right after
    // sign-in / opening the app — the app is already 'active' on mount and
    // AppState only fires on a *change*.
    startOnline();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        startOnline();
      } else if (state === 'background') {
        stop();
        send('idle');
      }
    });

    return () => {
      sub.remove();
      stop();
    };
  }, [enabled, token]);
}

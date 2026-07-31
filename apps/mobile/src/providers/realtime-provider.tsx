import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';

import { useHeartbeat } from '@/hooks/use-heartbeat';
import { useSseConnection, type SseStreamCallbacks } from '@/hooks/use-sse-connection';
import { applyRealtimeEvent } from '@/lib/realtime-handlers';
import { openUserEvents, type MmEvent } from '@/lib/sse';
import { useAuth } from '@/providers/auth-provider';

export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

interface RealtimeContextValue {
  status: RealtimeStatus;
  /** Called by the chat-detail screen to flag which channel is in the
   *  foreground. The Phase-3 ``post.created`` handler reads this so it
   *  doesn't bump the unread badge on the channel the user is actively
   *  reading. ``null`` means no channel is open. */
  registerActiveChannel: (channelId: string | null) => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { token, status: authStatus } = useAuth();
  const queryClient = useQueryClient();
  // ``connectionStatus`` mirrors the SSE state machine; the exposed
  // ``status`` is derived so the public value is forced to 'idle'
  // whenever auth isn't ready, without us having to keep the two in
  // sync via a setter inside the effect body.
  const [connectionStatus, setConnectionStatus] = useState<RealtimeStatus>('idle');
  const isAuthed = authStatus === 'authenticated' && token != null;
  const status: RealtimeStatus = isAuthed ? connectionStatus : 'idle';
  const activeChannelRef = useRef<string | null>(null);

  const registerActiveChannel = useCallback((channelId: string | null) => {
    activeChannelRef.current = channelId;
  }, []);

  // Wire AppState → TanStack ``focusManager`` once. This makes every
  // ``useQuery`` automatically refetch (if stale) when the app returns
  // to the foreground, independent of the SSE reconnect path. Belt-
  // and-suspenders so a quick foreground flip refreshes even before
  // the socket has had a chance to come back.
  useEffect(() => {
    focusManager.setEventListener((handleFocus) => {
      const sub = AppState.addEventListener('change', (state) => {
        if (Platform.OS === 'web') return;
        handleFocus(state === 'active');
      });
      return () => sub.remove();
    });
  }, []);

  // Wire NetInfo → TanStack ``onlineManager`` once. Makes ``useQuery``
  // pause while offline and refetch automatically when connectivity
  // returns — separate from the SSE reconnect plumbing below, which
  // handles the live stream.
  useEffect(() => {
    onlineManager.setEventListener((setOnline) => {
      return NetInfo.addEventListener((state) => {
        setOnline(state.isConnected === true);
      });
    });
  }, []);

  // The global stream's connection lifecycle (connect/reconnect with backoff,
  // background teardown, network-edge fast reconnect, stable-reset) lives in
  // the shared ``useSseConnection`` hook — the same machine the per-channel
  // stream uses, so the two can't drift.
  const open = useCallback(
    (cb: SseStreamCallbacks) => {
      if (!token) return () => {};
      return openUserEvents({ token, ...cb });
    },
    [token],
  );

  const onEvent = useCallback(
    (event: MmEvent) => {
      applyRealtimeEvent(queryClient, event, activeChannelRef.current);
      if (__DEV__) {
        console.log(`[realtime] ${event.type}`, event.channel_id ?? '');
      }
    },
    [queryClient],
  );

  const onReconnect = useCallback(() => {
    // After missing an unknown window of events, revalidate everything the
    // user might be looking at. No-ops if the queries aren't mounted.
    void queryClient.invalidateQueries({ queryKey: ['channels'] });
    const channelId = activeChannelRef.current;
    if (channelId) {
      void queryClient.invalidateQueries({ queryKey: ['mm-posts', channelId] });
      void queryClient.invalidateQueries({ queryKey: ['mm-channel-members', channelId] });
    }
  }, [queryClient]);

  useSseConnection({
    enabled: isAuthed,
    open,
    onEvent,
    onReconnect,
    onStatusChange: setConnectionStatus,
  });

  // Publish our own global presence so peers see us online. Inbound
  // presence is consumed via member ``status`` / ``user.status``; without
  // this outbound beat an iOS user would always appear OFFLINE to others.
  useHeartbeat(isAuthed, token);

  const value = useMemo<RealtimeContextValue>(
    () => ({ status, registerActiveChannel }),
    [status, registerActiveChannel],
  );

  return <RealtimeContext value={value}>{children}</RealtimeContext>;
}

export function useRealtime(): RealtimeContextValue {
  const value = use(RealtimeContext);
  if (!value) {
    throw new Error('useRealtime must be used inside RealtimeProvider');
  }
  return value;
}

export function useRealtimeStatus(): RealtimeStatus {
  return useRealtime().status;
}

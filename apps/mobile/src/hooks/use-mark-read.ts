import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState, type ViewToken } from 'react-native';

import { markMmRead } from '@/lib/api';
import type { ChatRow } from '@/lib/chat-grouping';
import { useAuth } from '@/providers/auth-provider';

const DEBOUNCE_MS = 600;

interface UseMarkReadResult {
  viewabilityConfig: {
    itemVisiblePercentThreshold: number;
    minimumViewTime: number;
  };
  onViewableItemsChanged: (info: { viewableItems: ViewToken<ChatRow>[] }) => void;
}

/**
 * Returns props to plug into the Legend List for read-receipt tracking. Maintains a
 * sticky `lastSentReadId` so we never POST the same post_id twice, debounces
 * the request 600ms after viewability settles, and flushes immediately when
 * the app goes to background so a swipe-away still records the read.
 */
export function useMarkRead(channelId: string): UseMarkReadResult {
  const { token } = useAuth();
  const lastSentRef = useRef<number>(0);
  const pendingRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const id = pendingRef.current;
    if (id <= lastSentRef.current || !token) return;
    lastSentRef.current = id;
    void markMmRead(token, channelId, id).catch(() => {
      // Best-effort. Reset lastSent so a subsequent viewability event retries.
      lastSentRef.current = 0;
    });
  }, [channelId, token]);

  const schedule = useCallback(
    (postId: number) => {
      if (postId <= lastSentRef.current) return;
      pendingRef.current = Math.max(pendingRef.current, postId);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, DEBOUNCE_MS);
    },
    [flush],
  );

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<ChatRow>[] }) => {
      let maxId = 0;
      for (const v of viewableItems) {
        if (v.item?.kind === 'message' && v.item.post.post_id > maxId) {
          maxId = v.item.post.post_id;
        }
      }
      if (maxId > 0) schedule(maxId);
    },
    [schedule],
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') flush();
    });
    return () => {
      sub.remove();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [flush]);

  return useMemo(
    () => ({
      viewabilityConfig: {
        itemVisiblePercentThreshold: 60,
        minimumViewTime: 400,
      },
      onViewableItemsChanged,
    }),
    [onViewableItemsChanged],
  );
}

import { useCallback, useEffect, useRef } from "react";
import { sendMmTypingHeartbeat } from "@/lib/api";

const TYPING_MIN_INTERVAL_MS = 2_500;

/**
 * Per-channel typing-indicator throttle.
 *
 * Global online/idle/offline presence is owned by ``useHeartbeat`` —
 * this hook only handles the ephemeral "is typing in this channel"
 * bubble. Returns a ``signalTyping()`` to call on composer keystrokes;
 * the call is rate-limited so we don't hammer the server.
 */
export function useChannelPresence(
  channelId: string | null | undefined,
): { signalTyping: () => void } {
  const lastTypingSentRef = useRef<number>(0);

  // No-op effect retained so the public hook surface (channel-scoped
  // cleanup) is preserved if we re-introduce per-channel state later.
  useEffect(() => {
    if (!channelId) return;
    return () => {};
  }, [channelId]);

  const signalTyping = useCallback(() => {
    if (!channelId) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_MIN_INTERVAL_MS) return;
    lastTypingSentRef.current = now;
    void sendMmTypingHeartbeat(channelId);
  }, [channelId]);

  return { signalTyping };
}

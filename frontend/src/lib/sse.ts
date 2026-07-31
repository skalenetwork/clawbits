// Minimal fetch-based SSE parser with liveness detection.
//
// EventSource can't send the cookies/headers we need the way we need, so
// we stream the response body with fetch and split on the "\n\n" frame
// boundary ourselves. Only the subset of the SSE spec we use is
// implemented: data lines and comments (lines starting with ":", which
// the server sends as periodic keepalives).
//
// Liveness — why the watchdog exists. The server emits a ":" keepalive
// comment every ~20s (see clawbits/realtime/sse.py). Without a client-side
// idle check, a half-open socket (proxy idle-drop, NAT rebind, laptop
// sleep, mobile radio handoff) leaves `reader.read()` blocked with no
// error — sometimes for minutes, until the OS TCP timeout — while events
// pile up server-side and never arrive. That's the "live message updates
// are delayed 5-20s" failure mode. We arm a watchdog that trips when no
// bytes (data OR keepalive) arrive within `idleTimeoutMs`; on trip we
// abort the current attempt and reconnect immediately, so a dead stream is
// detected within roughly one keepalive interval instead of a TCP timeout.

export type SseHandler = (event: unknown) => void;

export interface SseConnection {
  close: () => void;
}

export interface SseOptions {
  onError?: (err: unknown) => void;
  onOpen?: () => void;
  signal?: AbortSignal;
  /** Reconnect if no bytes arrive within this window. Kept a small
   *  multiple of the server keepalive cadence (20s) so a single late or
   *  dropped keepalive doesn't trigger a false reconnect, but a genuinely
   *  dead socket is caught fast. Default 45s (≈ two missed keepalives). */
  idleTimeoutMs?: number;
}

export function openSseStream(
  url: string,
  onEvent: SseHandler,
  options: SseOptions = {},
): SseConnection {
  const idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
  const externalSignal = options.signal;

  let cancelled = false;
  // Per-attempt abort controller. Aborted either by the watchdog (stale
  // stream → reconnect) or by close()/external signal (permanent teardown).
  // A fresh one is created for each connect attempt so a watchdog abort
  // tears down only the current socket, not the whole stream.
  let attempt: AbortController | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  // True when the watchdog tripped, so the run loop reconnects immediately
  // (fresh backoff) and suppresses the synthetic AbortError from onError.
  let staleReconnect = false;

  const clearWatchdog = () => {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };
  const armWatchdog = () => {
    clearWatchdog();
    if (cancelled) return;
    watchdog = setTimeout(() => {
      // No bytes for idleTimeoutMs — treat the socket as dead. Aborting the
      // fetch unblocks the pending reader.read() and drops into the
      // reconnect path below.
      staleReconnect = true;
      attempt?.abort();
    }, idleTimeoutMs);
  };

  const teardown = () => {
    cancelled = true;
    clearWatchdog();
    attempt?.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) cancelled = true;
    else externalSignal.addEventListener("abort", teardown, { once: true });
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const run = async () => {
    let retryMs = 500;
    while (!cancelled) {
      staleReconnect = false;
      attempt = new AbortController();
      try {
        const res = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "text/event-stream" },
          signal: attempt.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed (${res.status})`);
        }
        retryMs = 500;
        // Fire on every successful (re)connect so callers can resync any
        // state that may have changed while the stream was down — the event
        // bus has no replay, so a reconnect is the moment to reconcile.
        options.onOpen?.();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        armWatchdog();
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          // Any bytes — a data frame OR a keepalive comment — prove the
          // stream is alive. Reset the watchdog before parsing.
          armWatchdog();
          buffer += decoder.decode(value, { stream: true });
          // Frames are separated by a blank line ("\n\n").
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith(":")) continue;  // comment / keepalive
              if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
              }
            }
            if (dataLines.length === 0) continue;
            const payload = dataLines.join("\n");
            try {
              onEvent(JSON.parse(payload));
            } catch {
              // Non-JSON payload — ignore.
            }
          }
        }
      } catch (err) {
        // Suppress the synthetic AbortError a watchdog/teardown raises —
        // only surface genuine connect/read failures.
        if (!cancelled && !staleReconnect && options.onError) options.onError(err);
      } finally {
        clearWatchdog();
      }
      if (cancelled) break;
      if (staleReconnect) {
        // Detected-dead stream: reconnect right away with fresh backoff.
        retryMs = 500;
        continue;
      }
      await sleep(retryMs);
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  };

  void run();

  return {
    close: teardown,
  };
}

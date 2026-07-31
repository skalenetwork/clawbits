/**
 * A house-styled video player: a native ``<video>`` with a custom glass-pill
 * control layer ({@link VideoControls}) over it, no browser chrome.
 *
 * Owns the robustness the bare element lacks:
 *   - autoplay with a muted fallback (iOS/Safari refuse unmuted autoplay),
 *     and we never let a rejected ``play()`` promise go unhandled;
 *   - error recovery: on a media error (typically an expired presigned R2
 *     URL) we re-mint a fresh URL via ``recoverSrc`` and restore position;
 *   - teardown on unmount (pause + detach src) so detached media elements
 *     don't pile up across repeated open/close;
 *   - auto-hiding controls + hidden cursor while playing.
 *
 * Element refs are only ever read inside effects / event handlers, and the
 * imperative ``actions`` are built in a mount effect (not during render), so
 * playback stays imperative while satisfying the React Compiler ref rules.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createMediaActions,
  createMediaStore,
  type MediaActions,
} from "./useMediaState";
import { VideoControls } from "./VideoControls";

interface VideoProps {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  /** Tailwind classes for the inner ``<video>`` element. */
  className?: string;
  /** Re-resolve a fresh source URL after a media error (e.g. the presigned
   *  R2 URL expired mid-playback). Returns ``null`` if it can't recover. */
  recoverSrc?: () => Promise<string | null>;
}

const HIDE_DELAY_MS = 2800;

export function Video({ src, poster, autoPlay, className, recoverSrc }: VideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [store] = useState(createMediaStore);

  // Built in an effect (deferred) so the ref reads don't happen during render.
  const [actions, setActions] = useState<MediaActions | null>(null);
  useEffect(() => {
    setActions(
      createMediaActions(
        () => videoRef.current,
        () => containerRef.current,
      ),
    );
  }, []);

  // The source actually bound to the element — diverges from ``src`` only
  // after an error-recovery re-mint.
  const [currentSrc, setCurrentSrc] = useState(src);
  useEffect(() => {
    setCurrentSrc(src);
  }, [src]);

  // Wire the store to the element for the lifetime of the component.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    return store.attach(v, containerRef.current);
  }, [store]);

  // Teardown: detach the source so the element can be GC'd promptly.
  useEffect(() => {
    const v = videoRef.current;
    return () => {
      if (!v) return;
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch {
        /* element already torn down */
      }
    };
  }, []);

  // Autoplay with a muted fallback.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !autoPlay) return;
    void v.play().catch(() => {
      v.muted = true;
      void v.play().catch(() => {/* still blocked — user can press play */});
    });
  }, [currentSrc, autoPlay]);

  // Error recovery — re-mint the URL and restore the playhead. Capped so a
  // permanently-broken source can't loop re-minting forever.
  const recoveringRef = useRef(false);
  const recoverAttemptsRef = useRef(0);
  useEffect(() => {
    recoverAttemptsRef.current = 0;
  }, [src]);
  const onError = useCallback(() => {
    const v = videoRef.current;
    if (!v || !recoverSrc || recoveringRef.current) return;
    if (recoverAttemptsRef.current >= 2) return;
    recoverAttemptsRef.current += 1;
    recoveringRef.current = true;
    const at = v.currentTime;
    const wasPlaying = !v.paused;
    recoverSrc()
      .then((fresh) => {
        recoveringRef.current = false;
        if (!fresh) return;
        setCurrentSrc(fresh);
        const restore = () => {
          v.removeEventListener("loadedmetadata", restore);
          try {
            v.currentTime = at;
          } catch {
            /* out of range */
          }
          if (wasPlaying) void v.play().catch(() => {/* rejected */});
        };
        v.addEventListener("loadedmetadata", restore);
      })
      .catch(() => {
        recoveringRef.current = false;
      });
  }, [recoverSrc]);

  // Auto-hide controls (kept up while paused).
  const [active, setActive] = useState(true);
  const hideTimer = useRef<number | null>(null);
  const poke = useCallback(() => {
    setActive(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      const v = videoRef.current;
      if (v && !v.paused) setActive(false);
    }, HIDE_DELAY_MS);
  }, []);
  useEffect(
    () => () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  // Player-scoped keyboard shortcuts. We deliberately leave the arrow keys
  // alone so the AttachmentViewer keeps prev/next; ``stopPropagation`` on the
  // ones we own keeps them from reaching the viewer's window handler.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!actions) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          e.stopPropagation();
          actions.togglePlay();
          poke();
          break;
        case "j":
          e.stopPropagation();
          actions.seekBy(-10);
          poke();
          break;
        case "l":
          e.stopPropagation();
          actions.seekBy(10);
          poke();
          break;
        case "m":
          e.stopPropagation();
          actions.toggleMute();
          break;
        case "f":
          e.stopPropagation();
          void actions.toggleFullscreen();
          break;
        default:
          break;
      }
    },
    [actions, poke],
  );

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerMove={poke}
      onPointerLeave={() => {
        const v = videoRef.current;
        if (v && !v.paused) setActive(false);
      }}
      className={`group/player relative flex max-h-full max-w-full items-center justify-center bg-black outline-none ${
        active ? "" : "cursor-none"
      }`}
    >
      <video
        ref={videoRef}
        src={currentSrc}
        poster={poster}
        playsInline
        onError={onError}
        onClick={() => {
          actions?.togglePlay();
          poke();
        }}
        className={className ?? "max-h-full max-w-full"}
      />
      {actions && (
        <VideoControls
          store={store}
          actions={actions}
          visible={active}
          onActivity={poke}
        />
      )}
    </div>
  );
}

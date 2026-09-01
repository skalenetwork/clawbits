/**
 * A tiny external store over a native ``<video>`` element, read with
 * ``useSyncExternalStore`` + per-field selectors.
 *
 * Why a store and not React state: ``timeupdate`` (and our rAF loop) fire
 * many times a second. Holding ``currentTime`` in React state would re-render
 * the whole controls tree on every tick. Instead each control subscribes to
 * exactly the slice it needs — the play button to ``paused``, the scrubber to
 * ``currentTime`` — so a tick only re-renders the scrubber. This also matches
 * the React Compiler grain: playback is driven imperatively through a ref, and
 * time never enters React state.
 */
import { useSyncExternalStore } from "react";

export interface MediaSnapshot {
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number;
  /** End (seconds) of the buffered range covering ``currentTime``. */
  bufferedEnd: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  /** Buffering / stalled — drives the centre spinner. */
  waiting: boolean;
  fullscreen: boolean;
  pip: boolean;
}

const INITIAL: MediaSnapshot = {
  paused: true,
  ended: false,
  currentTime: 0,
  duration: 0,
  bufferedEnd: 0,
  volume: 1,
  muted: false,
  playbackRate: 1,
  waiting: false,
  fullscreen: false,
  pip: false,
};

export interface MediaStore {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => MediaSnapshot;
  /** Wire the store to an element (+ the container used for fullscreen).
   *  Returns a detach function that removes every listener. */
  attach: (video: HTMLVideoElement, container: HTMLElement | null) => () => void;
}

export function createMediaStore(): MediaStore {
  let snapshot: MediaSnapshot = INITIAL;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<MediaSnapshot>) => {
    const next = { ...snapshot, ...patch };
    let changed = false;
    for (const key of Object.keys(patch) as (keyof MediaSnapshot)[]) {
      if (snapshot[key] !== next[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    snapshot = next;
    for (const l of listeners) l();
  };

  return {
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getSnapshot: () => snapshot,
    attach: (video, container) => {
      const bufferedEnd = () => {
        try {
          const b = video.buffered;
          const t = video.currentTime;
          for (let i = 0; i < b.length; i++) {
            if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.5) return b.end(i);
          }
          return b.length ? b.end(b.length - 1) : 0;
        } catch {
          return 0;
        }
      };
      const syncCore = () => {
        set({
          paused: video.paused,
          ended: video.ended,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          volume: video.volume,
          muted: video.muted,
          playbackRate: video.playbackRate,
        });
      };
      const syncTime = () => {
        set({ currentTime: video.currentTime, bufferedEnd: bufferedEnd() });
      };

      // rAF loop for a smooth scrubber while playing (``timeupdate`` only
      // fires ~4×/s, which looks steppy).
      let raf = 0;
      const tick = () => {
        set({ currentTime: video.currentTime, bufferedEnd: bufferedEnd() });
        raf = requestAnimationFrame(tick);
      };
      const startRaf = () => {
        if (!raf) raf = requestAnimationFrame(tick);
      };
      const stopRaf = () => {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      };

      const onPlay = () => {
        set({ paused: false, ended: false });
        startRaf();
      };
      const onPause = () => {
        set({ paused: true });
        stopRaf();
        syncTime();
      };
      const onEnded = () => {
        set({ ended: true, paused: true });
        stopRaf();
      };
      const onWaiting = () => { set({ waiting: true }); };
      const onPlaying = () => { set({ waiting: false }); };
      const onFsChange = () => {
        set({
          fullscreen: container
            ? document.fullscreenElement === container
            : Boolean(document.fullscreenElement),
        });
      };
      const onEnterPip = () => { set({ pip: true }); };
      const onLeavePip = () => { set({ pip: false }); };

      video.addEventListener("loadedmetadata", syncCore);
      video.addEventListener("durationchange", syncCore);
      video.addEventListener("timeupdate", syncTime);
      video.addEventListener("progress", syncTime);
      video.addEventListener("play", onPlay);
      video.addEventListener("pause", onPause);
      video.addEventListener("ended", onEnded);
      video.addEventListener("waiting", onWaiting);
      video.addEventListener("playing", onPlaying);
      video.addEventListener("volumechange", syncCore);
      video.addEventListener("ratechange", syncCore);
      video.addEventListener("seeked", syncTime);
      video.addEventListener("enterpictureinpicture", onEnterPip);
      video.addEventListener("leavepictureinpicture", onLeavePip);
      document.addEventListener("fullscreenchange", onFsChange);

      // Prime from whatever state the element is already in.
      syncCore();
      syncTime();
      if (!video.paused) startRaf();

      return () => {
        stopRaf();
        video.removeEventListener("loadedmetadata", syncCore);
        video.removeEventListener("durationchange", syncCore);
        video.removeEventListener("timeupdate", syncTime);
        video.removeEventListener("progress", syncTime);
        video.removeEventListener("play", onPlay);
        video.removeEventListener("pause", onPause);
        video.removeEventListener("ended", onEnded);
        video.removeEventListener("waiting", onWaiting);
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("volumechange", syncCore);
        video.removeEventListener("ratechange", syncCore);
        video.removeEventListener("seeked", syncTime);
        video.removeEventListener("enterpictureinpicture", onEnterPip);
        video.removeEventListener("leavepictureinpicture", onLeavePip);
        document.removeEventListener("fullscreenchange", onFsChange);
      };
    },
  };
}

/** Subscribe to one derived slice of the media state. Keep the selector
 *  returning a *primitive* — React compares with ``Object.is``, so an
 *  object selection would re-render every tick (and risk a loop).
 *
 *  ``store.subscribe`` is stable, so a fresh ``getSelected`` per render
 *  (closing over the latest selector) is fine and doesn't re-subscribe. */
export function useMediaSelector<T>(
  store: MediaStore,
  selector: (s: MediaSnapshot) => T,
): T {
  const getSelected = () => selector(store.getSnapshot());
  return useSyncExternalStore(store.subscribe, getSelected, getSelected);
}

// ---------------------------------------------------------------------------
// Imperative actions — playback is driven straight on the DOM node.
// ---------------------------------------------------------------------------

export interface MediaActions {
  togglePlay: () => void;
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  seekBy: (delta: number) => void;
  setRate: (r: number) => void;
  toggleMute: () => void;
  setVolume: (v: number) => void;
  togglePip: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
}

type FullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

/** Takes element getters (typically ``useCallback`` wrappers around the
 *  refs) so the element is read lazily when an action runs, never during
 *  render. */
export function createMediaActions(
  getVideo: () => HTMLVideoElement | null,
  getContainer: () => HTMLElement | null,
): MediaActions {
  const clampSeek = (v: HTMLVideoElement, t: number) => {
    if (!Number.isFinite(t)) return;
    const max = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : t;
    v.currentTime = Math.max(0, Math.min(t, max));
  };
  return {
    togglePlay() {
      const v = getVideo();
      if (!v) return;
      if (v.paused) void v.play().catch(() => {/* gesture/autoplay rejected */});
      else v.pause();
    },
    play() {
      const v = getVideo();
      if (v) void v.play().catch(() => {/* rejected */});
    },
    pause() {
      getVideo()?.pause();
    },
    seek(t) {
      const v = getVideo();
      if (v) clampSeek(v, t);
    },
    seekBy(delta) {
      const v = getVideo();
      if (v) clampSeek(v, v.currentTime + delta);
    },
    setRate(r) {
      const v = getVideo();
      if (v) v.playbackRate = r;
    },
    toggleMute() {
      const v = getVideo();
      if (v) v.muted = !v.muted;
    },
    setVolume(vol) {
      const v = getVideo();
      if (!v) return;
      const clamped = Math.max(0, Math.min(1, vol));
      v.volume = clamped;
      v.muted = clamped === 0;
    },
    async togglePip() {
      const v = getVideo();
      if (!v) return;
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else if (document.pictureInPictureEnabled) await v.requestPictureInPicture();
      } catch {
        /* user denied or unsupported */
      }
    },
    async toggleFullscreen() {
      const c = getContainer();
      // Typed wider than the DOM lib so the iOS-only entry point below is
      // reachable without an assertion at the call site.
      const v: FullscreenVideo | null = getVideo();
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          return;
        }
        if (c?.requestFullscreen) {
          await c.requestFullscreen();
          return;
        }
        // iOS Safari: only the <video> itself can go fullscreen (native
        // controls take over there).
        v?.webkitEnterFullscreen?.();
      } catch {
        /* rejected */
      }
    },
  };
}

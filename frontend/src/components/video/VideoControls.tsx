/**
 * The house-styled control layer for {@link Video}. A single floating glass
 * pill over a soft bottom scrim, HugeIcons line glyphs, tabular-nums time, one
 * indigo accent on the scrubber — matching the AttachmentViewer chrome.
 *
 * Each control is its own component subscribing (via ``useMediaSelector``) to
 * just the slice it renders, so a playing video's per-frame ``currentTime``
 * updates re-render only the scrubber, never the buttons.
 */
import { useRef, useState } from "react";
import {
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Loading02Icon,
  PauseIcon,
  PictureInPictureOnIcon,
  PlayIcon,
  VolumeHighIcon,
  VolumeMute02Icon,
} from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import {
  type MediaActions,
  type MediaStore,
  useMediaSelector,
} from "./useMediaState";

const ICON_BTN =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-white/85 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40";

function formatTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const s = Math.floor(t % 60);
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${String(h)}:${String(m).padStart(2, "0")}:${ss}`;
  return `${String(m)}:${ss}`;
}

interface ControlProps {
  store: MediaStore;
  actions: MediaActions;
}

function PlayButton({ store, actions }: ControlProps) {
  const showPlay = useMediaSelector(store, (s) => s.paused || s.ended);
  return (
    <button
      type="button"
      onClick={() => { actions.togglePlay(); }}
      aria-label={showPlay ? "Play" : "Pause"}
      className={ICON_BTN}
    >
      <Icon icon={showPlay ? PlayIcon : PauseIcon} className="size-[18px]" />
    </button>
  );
}

function TimeDisplay({ store }: { store: MediaStore }) {
  const cur = useMediaSelector(store, (s) => Math.floor(s.currentTime));
  const dur = useMediaSelector(store, (s) => Math.floor(s.duration));
  return (
    <div className="flex shrink-0 items-center gap-1 px-0.5 text-xs tabular-nums text-white/75">
      <span>{formatTime(cur)}</span>
      <span className="text-white/35">/</span>
      <span className="text-white/55">{formatTime(dur)}</span>
    </div>
  );
}

function Scrubber({ store, actions, onActivity }: ControlProps & { onActivity: () => void }) {
  const ratio = useMediaSelector(store, (s) =>
    s.duration > 0 ? Math.min(1, s.currentTime / s.duration) : 0,
  );
  const buffered = useMediaSelector(store, (s) =>
    s.duration > 0 ? Math.min(1, s.bufferedEnd / s.duration) : 0,
  );
  const duration = useMediaSelector(store, (s) => s.duration);
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const ratioFromX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  const seekToX = (clientX: number) => {
    if (duration > 0) actions.seek(ratioFromX(clientX) * duration);
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.floor(duration)}
      aria-valuenow={Math.floor(ratio * duration)}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        seekToX(e.clientX);
        onActivity();
      }}
      onPointerMove={(e) => {
        setHover(ratioFromX(e.clientX));
        if (dragging) seekToX(e.clientX);
      }}
      onPointerUp={(e) => {
        setDragging(false);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* capture already released */
        }
      }}
      onPointerLeave={() => { setHover(null); }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.stopPropagation();
          actions.seekBy(5);
        } else if (e.key === "ArrowLeft") {
          e.stopPropagation();
          actions.seekBy(-5);
        }
      }}
      className="group/scrub relative flex h-5 grow cursor-pointer items-center outline-none"
    >
      <div className="relative h-1 w-full rounded-full bg-white/20">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-white/30"
          style={{ width: `${String(buffered * 100)}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-indigo-400"
          style={{ width: `${String(ratio * 100)}%` }}
        />
        <div
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-sm shadow-black/40 transition-transform duration-150 group-hover/scrub:scale-110"
          style={{ left: `${String(ratio * 100)}%` }}
        />
      </div>
      {hover !== null && duration > 0 && (
        <div
          className="pointer-events-none absolute -top-7 rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white"
          style={{ left: `${String(hover * 100)}%`, transform: "translateX(-50%)" }}
        >
          {formatTime(hover * duration)}
        </div>
      )}
    </div>
  );
}

function VolumeButton({ store, actions }: ControlProps) {
  const off = useMediaSelector(store, (s) => s.muted || s.volume === 0);
  return (
    <button
      type="button"
      onClick={() => { actions.toggleMute(); }}
      aria-label={off ? "Unmute" : "Mute"}
      className={ICON_BTN}
    >
      <Icon icon={off ? VolumeMute02Icon : VolumeHighIcon} className="size-[18px]" />
    </button>
  );
}

const RATES = [1, 1.25, 1.5, 2, 0.5];

function RateButton({ store, actions }: ControlProps) {
  const rate = useMediaSelector(store, (s) => s.playbackRate);
  return (
    <button
      type="button"
      onClick={() => {
        const i = RATES.indexOf(rate);
        actions.setRate(RATES[(i + 1) % RATES.length] ?? 1);
      }}
      aria-label="Playback speed"
      className="flex h-8 shrink-0 items-center justify-center rounded-lg px-1.5 text-xs font-medium tabular-nums text-white/85 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      {rate}×
    </button>
  );
}

function PipButton({ store, actions }: ControlProps) {
  const pip = useMediaSelector(store, (s) => s.pip);
  const supported =
    typeof document !== "undefined" && document.pictureInPictureEnabled;
  if (!supported) return null;
  return (
    <button
      type="button"
      onClick={() => { void actions.togglePip(); }}
      aria-label={pip ? "Exit picture in picture" : "Picture in picture"}
      className={ICON_BTN}
    >
      <Icon icon={PictureInPictureOnIcon} className="size-[17px]" />
    </button>
  );
}

function FullscreenButton({ store, actions }: ControlProps) {
  const fs = useMediaSelector(store, (s) => s.fullscreen);
  return (
    <button
      type="button"
      onClick={() => { void actions.toggleFullscreen(); }}
      aria-label={fs ? "Exit full screen" : "Full screen"}
      className={ICON_BTN}
    >
      <Icon icon={fs ? ArrowShrink01Icon : ArrowExpand01Icon} className="size-[17px]" />
    </button>
  );
}

/** Big centre affordance shown while paused / buffering. */
function CenterButton({ store, actions }: ControlProps) {
  const paused = useMediaSelector(store, (s) => s.paused);
  const waiting = useMediaSelector(store, (s) => s.waiting);
  if (!paused && !waiting) return null;
  return (
    <button
      type="button"
      onClick={() => { actions.togglePlay(); }}
      aria-label="Play"
      className="pointer-events-auto absolute left-1/2 top-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/95 ring-1 ring-inset ring-white/15 backdrop-blur-md transition-transform duration-200 hover:scale-105"
    >
      <Icon
        icon={waiting ? Loading02Icon : PlayIcon}
        className={waiting ? "size-7 animate-spin" : "size-7"}
      />
    </button>
  );
}

export function VideoControls({
  store,
  actions,
  visible,
  onActivity,
}: ControlProps & { visible: boolean; onActivity: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-0">
      <CenterButton store={store} actions={actions} />

      {/* Bottom scrim so glyphs keep contrast over bright frames. */}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/55 to-transparent transition-opacity duration-300 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* The floating glass control pill. */}
      <div
        onPointerDown={onActivity}
        className={`absolute inset-x-3 bottom-3 flex h-11 items-center gap-1.5 rounded-2xl border border-white/12 bg-black/30 px-2 shadow-lg shadow-black/40 ring-1 ring-inset ring-white/5 backdrop-blur-md transition-all duration-300 ${
          visible
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none translate-y-2 opacity-0"
        }`}
      >
        <PlayButton store={store} actions={actions} />
        <TimeDisplay store={store} />
        <Scrubber store={store} actions={actions} onActivity={onActivity} />
        <VolumeButton store={store} actions={actions} />
        <RateButton store={store} actions={actions} />
        <PipButton store={store} actions={actions} />
        <FullscreenButton store={store} actions={actions} />
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  Download01Icon,
  File01Icon,
  FileAudioIcon,
  PlayCircleIcon,
} from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import { AttachmentViewer } from "@/components/AttachmentViewer";
import { getMmFileDownloadUrl, type MmFile } from "@/lib/api";
import {
  stableDownloadUrl,
  stableThumbnailUrl,
} from "@/lib/attachmentUrlCache";
import { fileDescriptor, isInlinePreviewable } from "@/lib/fileTypes";
import { humanSize } from "@/lib/formatting";
import { toast } from "@/lib/toast";
import { openExternal } from "@/lib/desktop";
import {
  closeMediaWithTransition,
  openMediaWithTransition,
} from "@/lib/viewTransition";

interface MessageAttachmentsProps {
  files: MmFile[];
  /** Called after each image finishes loading. The composer uses this to
   *  re-trigger scroll-to-bottom: images load asynchronously, so by the
   *  time the bytes arrive the post height has grown and the user may
   *  no longer be at the bottom. */
  onImageLoaded?: () => void;
}

function isImage(f: MmFile) {
  return f.content_type.startsWith("image/");
}
function isVideo(f: MmFile) {
  return f.content_type.startsWith("video/");
}
function isAudio(f: MmFile) {
  return f.content_type.startsWith("audio/");
}

/**
 * Render the ``files`` array of a single post.
 *
 * Layout: images first (grid), then video/audio (one-column stack), then
 * generic file cards (one-column stack). Single image goes wide (up to
 * 28rem); 2+ images fall into a 2-column grid so neighboring posts read
 * neatly. Click image → lightbox with prev/next over the image set.
 *
 * Image previews use ``thumbnail_url`` when available (the composer
 * uploads a 1024px JPEG alongside the original), falling back to
 * ``download_url`` for small images that skipped thumbnail generation.
 */
export function MessageAttachments({ files, onImageLoaded }: MessageAttachmentsProps) {
  const images = files.filter(isImage);
  const videos = files.filter(isVideo);
  const audios = files.filter(isAudio);
  const others = files.filter(
    (f) => !isImage(f) && !isVideo(f) && !isAudio(f),
  );

  // Viewer state — the file set to page through, the selected index, and the
  // tapped thumbnail element so the viewer can morph open/closed from it.
  // Images page among images; a clicked file card pages among the other
  // (non-media) attachments on this same post.
  const [viewer, setViewer] = useState<{
    files: MmFile[];
    index: number;
    sourceEl: HTMLElement | null;
  } | null>(null);

  if (files.length === 0) return null;

  return (
    <div className="mt-1 flex flex-col gap-2">
      {images.length > 0 && (
        <ImageGrid
          images={images}
          onOpen={(idx, el) => {
            openMediaWithTransition(el, () => {
              setViewer({ files: images, index: idx, sourceEl: el });
            });
          }}
          onImageLoaded={onImageLoaded}
        />
      )}
      {videos.map((f) => (
        <VideoBlock key={f.file_id} file={f} />
      ))}
      {audios.map((f) => (
        <AudioBlock key={f.file_id} file={f} />
      ))}
      {others.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {others.map((f, idx) => (
            <FileCard
              key={f.file_id}
              file={f}
              onPreview={() => { setViewer({ files: others, index: idx, sourceEl: null }); }}
            />
          ))}
        </div>
      )}

      {viewer && (
        <AttachmentViewer
          files={viewer.files}
          initialIndex={viewer.index}
          onClose={() => {
            closeMediaWithTransition(viewer.sourceEl, () => { setViewer(null); });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

// Inline single-image previews clamp their aspect ratio into this window and
// center-crop (``object-cover``) anything outside it, so very tall or very
// wide images don't show as a sliver framed by gray letterbox bars. The
// lightbox still shows the full, uncropped image. 3:4 portrait to 2:1 landscape.
const MIN_PREVIEW_RATIO = 3 / 4;
const MAX_PREVIEW_RATIO = 2 / 1;

function ImageGrid({
  images,
  onOpen,
  onImageLoaded,
}: {
  images: MmFile[];
  onOpen: (index: number, sourceEl: HTMLElement | null) => void;
  onImageLoaded?: () => void;
}) {
  // Single image: one filled tile, clamped into a comfortable aspect-ratio
  // window so very tall or very wide images don't render as a thin sliver
  // boxed by big gray letterbox bars. Two+: 2-col grid with square tiles.
  // Rounding lives on the ``<img>`` element itself so the literal pixel
  // corners of the image are clipped, not just the parent container's
  // outline. ``rounded-xl`` ~ 12 px - matches the theme's card-level radius
  // (composer pill, popovers, dialogs).
  const imgRadius = "rounded-xl";
  if (images.length === 1) {
    const f = images[0]!;
    // Clamp the intrinsic ratio into [MIN, MAX] and fill the tile with
    // ``object-cover``: images inside the window show in full, taller/wider
    // ones are center-cropped to the window edge - never letterboxed. (The
    // full, uncropped image is one tap away in the lightbox.) Backend probes
    // dims on confirm, so the 1:1 fallback for unknown dims is exceptional.
    //
    // The box is driven by ``aspect-ratio`` + a computed ``max-width`` rather
    // than a fixed height, so it scales down cleanly on narrow screens while
    // staying inside the 28rem-wide / 24rem-tall (``max-w-md`` / ``max-h-96``)
    // envelope: ``min(28rem, 24rem * ratio)`` is the widest box of this ratio
    // that still fits under the height cap, which bounds tall tiles without a
    // separate ``max-height``.
    const natRatio = f.width && f.height ? f.width / f.height : 1;
    const ratio = Math.min(
      MAX_PREVIEW_RATIO,
      Math.max(MIN_PREVIEW_RATIO, natRatio),
    );
    const maxWidthRem = Math.min(28, 24 * ratio);
    return (
      <button
        type="button"
        style={{ maxWidth: `${String(maxWidthRem)}rem` }}
        onClick={(e) => { onOpen(0, e.currentTarget.querySelector("img")); }}
        className="group block w-full outline-none"
      >
        <div
          style={{ aspectRatio: ratio }}
          className={`relative w-full overflow-hidden bg-muted/30 ${imgRadius}`}
        >
          <ImageThumb
            file={f}
            className={`absolute inset-0 size-full object-cover ${imgRadius}`}
            onLoaded={onImageLoaded}
          />
        </div>
      </button>
    );
  }
  return (
    <div className="grid max-w-md grid-cols-2 gap-1.5">
      {images.map((f, idx) => (
        <button
          key={f.file_id}
          type="button"
          onClick={(e) => { onOpen(idx, e.currentTarget.querySelector("img")); }}
          className="group relative aspect-square outline-none"
        >
          <ImageThumb
            file={f}
            className={`size-full object-cover ${imgRadius}`}
            onLoaded={onImageLoaded}
          />
        </button>
      ))}
    </div>
  );
}

function ImageThumb({
  file,
  className,
  onLoaded,
}: {
  file: MmFile;
  className?: string;
  onLoaded?: () => void;
}) {
  // Resolve through the URL cache so periodic post-list polls don't
  // change the src on every render (otherwise the browser cache misses
  // and the image visibly flickers).
  const src =
    stableThumbnailUrl(
      file.file_id,
      file.thumbnail_url,
      file.thumbnail_url_expires_at,
    ) ||
    stableDownloadUrl(
      file.file_id,
      file.download_url,
      file.download_url_expires_at,
    ) ||
    undefined;
  if (!src) {
    // Backend returned the file without a download URL (presigner offline,
    // for example) — keep a neutral placeholder so the layout doesn't jump.
    return (
      <div className={`flex items-center justify-center bg-muted ${className ?? ""}`}>
        <Icon icon={File01Icon} className="size-6 text-muted-foreground" />
      </div>
    );
  }
  // Intrinsic width/height reserve aspect-ratio space *before* the bytes
  // arrive, so the message height is correct on first paint and the
  // composer's scroll-to-bottom call lands at the actual bottom. CSS
  // ``object-contain`` / ``object-cover`` still drives the visual size.
  return (
    <img
      src={src}
      alt={file.filename}
      loading="lazy"
      decoding="async"
      draggable={false}
      width={file.width ?? undefined}
      height={file.height ?? undefined}
      onLoad={onLoaded}
      className={className}
    />
  );
}

// ---------------------------------------------------------------------------
// Video / audio
// ---------------------------------------------------------------------------

function formatClock(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m)}:${s.toString().padStart(2, "0")}`;
}

function VideoBlock({ file }: { file: MmFile }) {
  const [src, setSrc] = useState<string | null>(file.download_url ?? null);
  // Client-generated poster (uploaded alongside the video). Resolved
  // through the URL cache so post-list polls don't churn the src.
  const poster =
    stableThumbnailUrl(
      file.file_id,
      file.thumbnail_url,
      file.thumbnail_url_expires_at,
    ) ?? undefined;
  // Reserve the real aspect-ratio box up front (dims captured at upload),
  // so the tile doesn't jump when the poster / video loads. 16:9 when unknown.
  const aspectRatio =
    file.width && file.height
      ? `${String(file.width)} / ${String(file.height)}`
      : "16 / 9";
  const duration = formatClock(file.duration_ms);

  // Pause a playing inline video once it scrolls out of view, so its audio
  // doesn't keep going from a tile the user has scrolled past. (virtua only
  // unmounts the row when it's well out of the overscan window; this stops
  // playback as soon as it's mostly off-screen.) We don't auto-resume — the
  // user taps play again, which is less surprising than sound resuming itself.
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!src) return;
    const v = videoRef.current;
    if (!v) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry && entry.intersectionRatio < 0.25 && !v.paused) v.pause();
      },
      { threshold: 0.25 },
    );
    io.observe(v);
    return () => { io.disconnect(); };
  }, [src]);

  // Reserve a *fixed* aspect-ratio box and absolutely position the poster /
  // video inside it, so the row height is deterministic from first paint and
  // never changes as the poster loads or playback swaps the <video> in. (A
  // normal-flow <video> resizes from its 2:1 default to its metadata ratio on
  // load, which mis-targets the channel's scroll-to-bottom and jumps the feed
  // when playback starts.) Falls back to 16:9 when dims are unknown.
  //
  // Browsers won't autoplay a video without bytes; we resolve a presigned URL
  // on demand the first time the user clicks Play. The poster shows the real
  // first frame in the meantime.
  return (
    <div
      style={{ aspectRatio }}
      className="relative max-h-96 w-full max-w-md overflow-hidden rounded-lg border border-border/40 bg-black"
    >
      {src ? (
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          controls
          autoPlay
          preload="metadata"
          className="absolute inset-0 size-full object-contain"
        />
      ) : (
        <button
          type="button"
          onClick={async () => {
            try {
              const r = await getMmFileDownloadUrl(file.file_id);
              setSrc(r.url);
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Could not load video");
            }
          }}
          className="group absolute inset-0 block size-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={`Play ${file.filename}`}
        >
          {poster && (
            <img
              src={poster}
              alt={file.filename}
              loading="lazy"
              decoding="async"
              draggable={false}
              className="absolute inset-0 size-full object-contain"
            />
          )}
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-black/40 backdrop-blur-md ring-1 ring-inset ring-white/15 transition-transform duration-200 group-hover:scale-105">
              <Icon icon={PlayCircleIcon} className="size-8 text-white/95" />
            </span>
          </span>
          {duration && (
            <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
              {duration}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

function AudioBlock({ file }: { file: MmFile }) {
  const [src, setSrc] = useState<string | null>(file.download_url ?? null);
  return (
    <div className="flex max-w-md flex-col gap-1.5 rounded-lg border border-border/40 bg-muted/30 p-2">
      <div className="flex items-center gap-2 px-1 text-xs">
        <Icon icon={FileAudioIcon} className="size-3.5 text-muted-foreground" />
        <span className="truncate font-medium text-foreground">{file.filename}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {humanSize(file.size_bytes)}
        </span>
      </div>
      {src ? (
        <audio src={src} controls preload="metadata" className="w-full" />
      ) : (
        <button
          type="button"
          onClick={async () => {
            try {
              const r = await getMmFileDownloadUrl(file.file_id);
              setSrc(r.url);
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Could not load audio");
            }
          }}
          className="rounded-md bg-background/60 px-2 py-1 text-xs text-muted-foreground hover:bg-background"
        >
          Load audio
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic file card
// ---------------------------------------------------------------------------

function FileCard({ file, onPreview }: { file: MmFile; onPreview: () => void }) {
  const [downloading, setDownloading] = useState(false);
  const desc = fileDescriptor(file.filename, file.content_type);
  const previewable = isInlinePreviewable(file.filename, file.content_type);

  const download = async () => {
    setDownloading(true);
    try {
      const r = await getMmFileDownloadUrl(file.file_id);
      // Open the presigned URL externally — system browser on desktop,
      // new tab on web. Its Content-Disposition: attachment triggers a
      // save with the original filename rather than an inline render.
      await openExternal(r.url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  };

  const onActivate = () => {
    if (previewable) onPreview();
    else void download();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className="group flex max-w-md cursor-pointer items-center gap-2.5 rounded-lg border border-border/40 bg-muted/30 px-3 py-2 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${desc.tint}`}>
        <Icon icon={desc.icon} className={`size-5 ${desc.color}`} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium text-foreground">
          {file.filename}
        </span>
        <span className="text-xs text-muted-foreground">
          {humanSize(file.size_bytes)}
        </span>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void download();
        }}
        disabled={downloading}
        aria-label={`Download ${file.filename}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon icon={Download01Icon} className="size-4" />
      </button>
    </div>
  );
}

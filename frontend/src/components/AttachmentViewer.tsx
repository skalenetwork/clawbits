import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Download01Icon,
  Loading02Icon,
} from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import { CodeBlock } from "@/components/CodeBlock";
import { Video } from "@/components/video/Video";
import { getMmFileDownloadUrl, type MmFile } from "@/lib/api";
import { stableDownloadUrl, stableThumbnailUrl } from "@/lib/attachmentUrlCache";
import { MEDIA_VT_NAME } from "@/lib/viewTransition";
import {
  fileDescriptor,
  languageForFile,
  previewKind,
  TEXT_PREVIEW_MAX_BYTES,
} from "@/lib/fileTypes";
import { humanSize } from "@/lib/formatting";
import { toast } from "@/lib/toast";
import { openExternal } from "@/lib/desktop";

interface AttachmentViewerProps {
  /** The set to page through with ←/→ — typically the current tab's items
   *  or a single message's attachments. */
  files: MmFile[];
  initialIndex: number;
  onClose: () => void;
}

/**
 * Full-screen, type-aware attachment viewer. Supersedes the image-only
 * lightbox: pages through ``files`` with ←/→, Esc closes, the backdrop
 * closes on click. Per file it renders the right surface — raster image,
 * `<video>`/`<audio>`, a PDF (from a typed blob we control), or
 * syntax-highlighted source for text/code (incl. html/svg shown as source,
 * never executed). Anything else falls back to a download card.
 *
 * Chrome (filename + counter pill, action pill, chevrons, portal-to-body,
 * ``data-state="open"`` so page-level Esc handlers defer to it).
 */
export function AttachmentViewer({ files, initialIndex, onClose }: AttachmentViewerProps) {
  const [index, setIndex] = useState(initialIndex);
  const current = files[index];
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Focus management: move focus into the modal on open and restore it to the
  // element that opened it on close, so keyboard users aren't dropped back at
  // the top of the page. ``Tab`` is trapped inside the dialog (below).
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  const goPrev = useCallback(() => {
    setIndex((i) => (i - 1 + files.length) % files.length);
  }, [files.length]);
  const goNext = useCallback(() => {
    setIndex((i) => (i + 1) % files.length);
  }, [files.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // If a player is fullscreen, let the browser exit fullscreen on this
        // Escape rather than also closing the viewer.
        if (document.fullscreenElement) return;
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft" && files.length > 1) {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight" && files.length > 1) {
        e.preventDefault();
        goNext();
      } else if (e.key === "Tab") {
        // Trap Tab within the dialog so focus can't escape to the page behind.
        const root = dialogRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(
            'a[href],button:not([disabled]),input,textarea,select,[tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.offsetParent !== null);
        if (focusables.length === 0) {
          e.preventDefault();
          root.focus();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (!root.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [goPrev, goNext, files.length, onClose]);

  if (!current) return null;

  const download = async () => {
    try {
      const r = await getMmFileDownloadUrl(current.file_id);
      await openExternal(r.url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed");
    }
  };

  const isImageKind = previewKind(current.filename, current.content_type) === "image";

  // Floating controls. For an image they sit on top of the image itself (the
  // image is the surface); for other types they sit on the contained panel.
  const chrome = (
    <ViewerChrome
      filename={current.filename}
      index={index}
      count={files.length}
      onClose={onClose}
      onDownload={() => { void download(); }}
      onPrev={goPrev}
      onNext={goNext}
    />
  );

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md outline-none"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={current.filename}
      data-state="open"
    >
      {isImageKind ? (
        // The image is the surface: it sizes to its own aspect ratio and the
        // controls float on top of *it*, not the viewport, so the viewer reads
        // as one minimal image rather than a full-screen UI. ``relative flex``
        // shrink-wraps the wrapper to the image so the chrome anchors to its
        // corners. A click on the backdrop (or the image) bubbles to onClose.
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative flex">
            <ViewerContent key={current.file_id} file={current} onDownload={download} />
            {chrome}
          </div>
        </div>
      ) : (
        // Non-image surfaces (video / pdf / text / fallback) keep a contained,
        // rounded panel; ``stopPropagation`` so interacting with them doesn't
        // close the viewer.
        <div
          className="absolute inset-4 flex items-center justify-center overflow-hidden rounded-2xl border border-white/15 bg-black/30 shadow-2xl sm:inset-6 md:inset-10"
          onClick={(e) => { e.stopPropagation(); }}
        >
          {/* Per-file content. ``key`` resets the inner fetch/blob state when
              the user navigates to a different attachment. */}
          <ViewerContent key={current.file_id} file={current} onDownload={download} />
          {chrome}
        </div>
      )}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------

/** Floating controls overlaid on the active surface — filename + counter
 *  (top-left), download + close (top-right), and prev/next chevrons. Buttons
 *  ``stopPropagation`` so a tap on a control never also triggers the backdrop
 *  close. Positioned ``absolute`` so it anchors to whatever wraps it — the
 *  image itself, or the contained panel for other file types. */
function ViewerChrome({
  filename,
  index,
  count,
  onClose,
  onDownload,
  onPrev,
  onNext,
}: {
  filename: string;
  index: number;
  count: number;
  onClose: () => void;
  onDownload: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const multiple = count > 1;
  return (
    <>
      {/* Top-left: filename + counter. */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[70%] items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-sm text-white/90 backdrop-blur-md">
        <span className="truncate font-medium">{filename}</span>
        {multiple && (
          <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/80">
            {index + 1} / {count}
          </span>
        )}
      </div>

      {/* Top-right: actions. */}
      <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-full bg-black/50 p-1 backdrop-blur-md">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
          aria-label="Download"
          className="flex size-8 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          <Icon icon={Download01Icon} className="size-4" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label="Close"
          className="flex size-8 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          <Icon icon={Cancel01Icon} className="size-4" />
        </button>
      </div>

      {multiple && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onPrev(); }}
            aria-label="Previous"
            className="absolute left-3 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white/85 backdrop-blur-md transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <Icon icon={ArrowLeft01Icon} className="size-5" />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onNext(); }}
            aria-label="Next"
            className="absolute right-3 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white/85 backdrop-blur-md transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <Icon icon={ArrowRight01Icon} className="size-5" />
          </button>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function ViewerContent({ file, onDownload }: { file: MmFile; onDownload: () => void }) {
  const kind = previewKind(file.filename, file.content_type);
  switch (kind) {
    case "image":
      return <ImageContent file={file} />;
    case "video":
      return <MediaContent file={file} tag="video" onDownload={onDownload} />;
    case "audio":
      return <MediaContent file={file} tag="audio" onDownload={onDownload} />;
    case "pdf":
      return <PdfContent file={file} onDownload={onDownload} />;
    case "text":
      return <TextContent file={file} onDownload={onDownload} />;
    default:
      return <FallbackContent file={file} onDownload={onDownload} />;
  }
}

/** Resolve a fresh presigned URL for a file (used by video/audio/blob
 *  fetches where the list payload didn't inline one). */
async function resolveFreshUrl(file: MmFile): Promise<string> {
  const r = await getMmFileDownloadUrl(file.file_id);
  return r.url;
}

function Spinner() {
  return (
    <div className="flex size-full items-center justify-center">
      <Icon icon={Loading02Icon} className="size-7 animate-spin text-white/80" />
    </div>
  );
}

function ImageContent({ file }: { file: MmFile }) {
  // Resolve the full-resolution URL — usually inlined on the list payload,
  // otherwise minted fresh.
  const [resolved, setResolved] = useState<string | null>(null);
  useEffect(() => {
    if (file.download_url) return;
    let cancelled = false;
    void resolveFreshUrl(file)
      .then((u) => {
        if (!cancelled) setResolved(u);
      })
      .catch(() => {
        /* keep thumbnail/placeholder */
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const full =
    stableDownloadUrl(file.file_id, file.download_url, file.download_url_expires_at) ??
    resolved ??
    null;
  // The exact bytes the inline thumbnail already painted — a browser-cache hit
  // so the morph target shows real pixels on the first frame instead of a
  // blank box while the full image decodes.
  const thumb =
    stableThumbnailUrl(file.file_id, file.thumbnail_url, file.thumbnail_url_expires_at) ??
    full ??
    file.thumbnail_url ??
    null;

  // Show the cached thumbnail immediately, then swap to full-res once it has
  // decoded off-screen so the upgrade doesn't flash mid-view. ``fullReady``
  // resets naturally because this component is keyed by file_id (it remounts
  // when navigating to another attachment), so we never set it synchronously.
  const [fullReady, setFullReady] = useState(false);
  useEffect(() => {
    if (!full || full === thumb) return;
    let cancelled = false;
    const pre = new Image();
    pre.onload = () => {
      if (!cancelled) setFullReady(true);
    };
    pre.src = full;
    return () => {
      cancelled = true;
      pre.onload = null;
    };
  }, [full, thumb]);

  const src = fullReady && full ? full : (thumb ?? full ?? "");

  // Pin the displayed box to the file's known aspect ratio fitted into the
  // viewport, so it's identical whether the cached thumbnail or the full-res
  // image is showing. Without this the box would track each bitmap's natural
  // size and visibly jump (small thumbnail -> larger full-res), and the morph
  // would aim at the wrong final size. ``width`` is the binding constraint of:
  // the viewport width (92vw), the width at which height hits 88dvh, and the
  // image's own width (so small images stay their natural size and never
  // upscale into a blurry full-screen blob). ``height: auto`` derives the rest
  // from the width/height attributes' aspect ratio.
  const ratioWH = file.width && file.height ? file.width / file.height : null;
  const sizeStyle =
    ratioWH && file.width
      ? {
          width: `min(92vw, calc(${ratioWH.toFixed(4)} * 88dvh), ${String(file.width)}px)`,
          height: "auto",
        }
      : undefined;

  return (
    <img
      src={src}
      alt={file.filename}
      draggable={false}
      width={file.width ?? undefined}
      height={file.height ?? undefined}
      style={{ viewTransitionName: MEDIA_VT_NAME, ...sizeStyle }}
      className="block max-h-[88dvh] max-w-[92vw] select-none rounded-2xl object-contain shadow-2xl"
    />
  );
}

function MediaContent({
  file,
  tag,
  onDownload,
}: {
  file: MmFile;
  tag: "video" | "audio";
  onDownload: () => void;
}) {
  const [src, setSrc] = useState(file.download_url ?? null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (src) return;
    let cancelled = false;
    void resolveFreshUrl(file)
      .then((u) => {
        if (!cancelled) setSrc(u);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [file, src]);

  if (error) return <FallbackContent file={file} onDownload={onDownload} />;
  if (!src) return <Spinner />;
  if (tag === "video") {
    return (
      <div className="flex size-full items-center justify-center px-4 py-14 sm:px-6">
        <Video
          src={src}
          poster={file.thumbnail_url ?? undefined}
          recoverSrc={() => resolveFreshUrl(file)}
          autoPlay
          className="block max-h-full max-w-full rounded-lg"
        />
      </div>
    );
  }
  return (
    <div className="w-full max-w-lg px-8">
      <audio src={src} controls autoPlay className="w-full" />
    </div>
  );
}

/** Fetch raw bytes for a file and expose them as an object URL / text.
 *  Returns null while loading; throws are surfaced via ``error``. */
function useFileBytes(file: MmFile, mode: "blob" | "text", blobType?: string) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let createdUrl: string | null = null;
    setBlobUrl(null);
    setText(null);
    setError(null);

    void (async () => {
      try {
        // Prefer an inlined URL; otherwise mint a fresh presigned one.
        const url =
          stableDownloadUrl(
            file.file_id,
            file.download_url,
            file.download_url_expires_at,
          ) ?? (await resolveFreshUrl(file));
        // Cross-origin GET to R2 — requires the web origin in the bucket
        // CORS allowlist. On failure (CORS / network / expiry / abort) we
        // degrade to the download fallback.
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        if (mode === "text") {
          const body = await res.text();
          if (!signal.aborted) setText(body);
        } else {
          const bytes = await res.arrayBuffer();
          if (signal.aborted) return;
          // Pin the MIME type ourselves so the browser renders it as the
          // intended type (e.g. application/pdf), never as executable HTML.
          const blob = new Blob([bytes], blobType ? { type: blobType } : undefined);
          createdUrl = URL.createObjectURL(blob);
          setBlobUrl(createdUrl);
        }
      } catch (e) {
        // Aborts (unmount / navigate) surface as DOMException — not errors.
        if (!signal.aborted) {
          setError(e instanceof Error ? e.message : "Preview failed");
        }
      }
    })();

    return () => {
      controller.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [file, mode, blobType]);

  return { blobUrl, text, error };
}

function PdfContent({ file, onDownload }: { file: MmFile; onDownload: () => void }) {
  const { blobUrl, error } = useFileBytes(file, "blob", "application/pdf");
  if (error) return <FallbackContent file={file} onDownload={onDownload} message={error} />;
  if (!blobUrl) return <Spinner />;
  return (
    <iframe
      src={blobUrl}
      title={file.filename}
      className="size-full bg-white px-2 py-14 sm:px-6"
    />
  );
}

function TextContent({ file, onDownload }: { file: MmFile; onDownload: () => void }) {
  const tooLarge = file.size_bytes > TEXT_PREVIEW_MAX_BYTES;
  const { text, error } = useFileBytes(file, tooLarge ? "blob" : "text");
  if (tooLarge) {
    return (
      <FallbackContent
        file={file}
        onDownload={onDownload}
        message="Too large to preview inline"
      />
    );
  }
  if (error) return <FallbackContent file={file} onDownload={onDownload} message={error} />;
  if (text === null) return <Spinner />;
  const lang = languageForFile(file.filename);
  // One immersive, full-bleed reading surface — the code fills the viewer
  // (no nested card/border), with the filename + actions floating over it.
  // ``pt-16`` clears the top pills; ``bg-card`` keeps Shiki tokens readable
  // in both themes (they follow the page's .dark class).
  return (
    <div className="size-full overflow-auto bg-card text-card-foreground">
      <div className="min-h-full px-5 pb-10 pt-16 sm:px-8">
        <CodeBlock code={text.replace(/\n$/, "")} lang={lang} bare />
      </div>
    </div>
  );
}

function FallbackContent({
  file,
  onDownload,
  message,
}: {
  file: MmFile;
  onDownload: () => void;
  message?: string;
}) {
  const desc = fileDescriptor(file.filename, file.content_type);
  return (
    <div className="flex flex-col items-center gap-4 px-8 text-center">
      <div className={`flex size-20 items-center justify-center rounded-2xl ${desc.tint}`}>
        <Icon icon={desc.icon} className={`size-9 ${desc.color}`} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="max-w-xs truncate font-medium text-white">{file.filename}</p>
        <p className="text-sm text-white/60">
          {message ?? "No preview available"} · {humanSize(file.size_bytes)}
        </p>
      </div>
      <button
        type="button"
        onClick={onDownload}
        className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
      >
        <Icon icon={Download01Icon} className="size-4" />
        Download
      </button>
    </div>
  );
}

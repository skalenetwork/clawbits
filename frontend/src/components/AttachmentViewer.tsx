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

/** Height of the viewport-anchored top bar. The media size budget subtracts
 *  it so the chrome can never end up sitting on the picture. Keep in sync
 *  with the bar's ``h-14`` class. */
const CHROME_H = "3.5rem";
/** Room held back on each side for the prev/next chevrons, as a custom
 *  property the image's width budget subtracts. Set only when there is
 *  something to page to, and only from ``sm`` up: on a phone-width viewport
 *  two 7rem gutters would eat most of the picture, so there the chevrons go
 *  back to floating over the image's left/right edges (its least
 *  content-dense strip) rather than shrinking it. */
const NAV_GUTTER = "[--nav-w:0px] sm:[--nav-w:7rem]";
/** Idle delay before the chrome fades down to a quiet state. */
const IDLE_MS = 2500;

/**
 * Full-screen, type-aware attachment viewer. Supersedes the image-only
 * lightbox: pages through ``files`` with ←/→, Esc closes, the backdrop
 * closes on click. Per file it renders the right surface — raster image,
 * `<video>`/`<audio>`, a PDF (from a typed blob we control), or
 * syntax-highlighted source for text/code (incl. html/svg shown as source,
 * never executed). Anything else falls back to a download card.
 *
 * Chrome (filename + counter pill, action pill, chevrons, portal-to-body,
 * ``data-state="open"`` so page-level Esc handlers defer to it) lives in a
 * bar *outside* the media plus gutters beside it, with the media's size
 * budget reserving that space, so no control is painted over the content
 * (the one exception being the chevrons on a phone-width viewport — see
 * ``NAV_GUTTER``). It fades to a quiet state while the user is just looking.
 */
export function AttachmentViewer({ files, initialIndex, onClose }: AttachmentViewerProps) {
  const [index, setIndex] = useState(initialIndex);
  const current = files[index];
  const dialogRef = useRef<HTMLDivElement>(null);
  const idle = useIdle(IDLE_MS);

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
  const multiple = files.length > 1;

  const nav = multiple ? <ViewerNav idle={idle} onPrev={goPrev} onNext={goNext} /> : null;

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-md outline-none"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={current.filename}
      data-state="open"
    >
      {/* The bar owns its own row, so the media below it starts where the bar
          ends and no control is ever painted over the content. */}
      <ViewerTopBar
        filename={current.filename}
        index={index}
        count={files.length}
        idle={idle}
        onClose={onClose}
        onDownload={() => { void download(); }}
      />

      {isImageKind ? (
        // The image is the surface: it sizes to its own aspect ratio inside
        // the space the bar left over, so the viewer still reads as one
        // minimal image rather than a full-screen UI. ``pb-14`` mirrors the
        // bar's row so the picture stays centred on the viewport instead of
        // being pushed low by it. A click on the backdrop (or the image)
        // bubbles to onClose.
        <div
          className={`relative flex min-h-0 flex-1 items-center justify-center pb-14 ${
            multiple ? NAV_GUTTER : ""
          }`}
        >
          <ViewerContent key={current.file_id} file={current} onDownload={download} />
          {nav}
        </div>
      ) : (
        // Non-image surfaces (video / pdf / text / fallback) keep a contained,
        // rounded panel; ``stopPropagation`` so interacting with them doesn't
        // close the viewer.
        <div
          className="relative mx-4 mb-4 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-white/15 bg-black/30 shadow-2xl sm:mx-6 sm:mb-6 md:mx-10 md:mb-10"
          onClick={(e) => { e.stopPropagation(); }}
        >
          {/* Per-file content. ``key`` resets the inner fetch/blob state when
              the user navigates to a different attachment. */}
          <ViewerContent key={current.file_id} file={current} onDownload={download} />
          {nav}
        </div>
      )}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------

/** True once ``delay`` ms have passed with no pointer or keyboard activity;
 *  any input wakes it back up. Drives the quiet-down of the chrome while the
 *  user is just looking at the picture. */
function useIdle(delay: number) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = window.setTimeout(() => { setIdle(true); }, delay);
    const wake = () => {
      // React bails out when the value is unchanged, so the common case
      // (moving the pointer while already awake) costs no render.
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { setIdle(true); }, delay);
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, wake);
    };
  }, [delay]);
  return idle;
}

/** Idle styling for a chrome group: fades down but never out, so the controls
 *  stay discoverable. Keyboard focus always restores full opacity, and users
 *  who asked for reduced motion never see the fade at all. */
function dimClass(idle: boolean) {
  // Variant utilities are emitted after their plain counterparts, so
  // ``focus-within:``/``motion-reduce:`` win over ``opacity-40`` on their own.
  return `transition-opacity duration-300 focus-within:opacity-100 motion-reduce:opacity-100 motion-reduce:transition-none ${
    idle ? "opacity-40" : "opacity-100"
  }`;
}

// ---------------------------------------------------------------------------

/** The viewer's own row above the media — filename + counter on the left,
 *  download + close on the right. It occupies layout (``h-14``, matching
 *  ``CHROME_H``) rather than floating, so it can never occlude the content.
 *  Buttons ``stopPropagation`` so a tap on a control never also triggers the
 *  backdrop close; empty bar space still closes, like the rest of the
 *  backdrop. */
function ViewerTopBar({
  filename,
  index,
  count,
  idle,
  onClose,
  onDownload,
}: {
  filename: string;
  index: number;
  count: number;
  idle: boolean;
  onClose: () => void;
  onDownload: () => void;
}) {
  const multiple = count > 1;
  return (
    <div
      className={`flex h-14 shrink-0 items-center justify-between gap-3 px-3 ${dimClass(idle)}`}
    >
      <div className="pointer-events-none flex min-w-0 items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-sm text-white/90 backdrop-blur-md">
        <span className="truncate font-medium">{filename}</span>
        {multiple && (
          <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/80">
            {index + 1} / {count}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-black/50 p-1 backdrop-blur-md">
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
    </div>
  );
}

/** Prev/next chevrons, centred on the media area. For images the media
 *  reserves ``--nav-w`` on each side so these land in the backdrop gutters
 *  instead of on the picture. */
function ViewerNav({
  idle,
  onPrev,
  onNext,
}: {
  idle: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const cls =
    "absolute top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white/85 backdrop-blur-md transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40";
  return (
    <div className={`pointer-events-none absolute inset-0 z-10 ${dimClass(idle)}`}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onPrev(); }}
        aria-label="Previous"
        className={`pointer-events-auto left-3 ${cls}`}
      >
        <Icon icon={ArrowLeft01Icon} className="size-5" />
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onNext(); }}
        aria-label="Next"
        className={`pointer-events-auto right-3 ${cls}`}
      >
        <Icon icon={ArrowRight01Icon} className="size-5" />
      </button>
    </div>
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

  // The space the chrome left over: the top bar's row is already gone from the
  // flex parent, and we hold back the same amount again at the bottom so the
  // picture stays optically centred in the viewport. Sideways it's the chevron
  // gutters the wrapper declares via ``--nav-w`` (0 when there's nothing to
  // page to, and on narrow viewports — see NAV_GUTTER).
  const availH = `88dvh - 2 * ${CHROME_H}`;
  const availW = "92vw - 2 * var(--nav-w, 0px)";

  // Pin the displayed box to the file's known aspect ratio fitted into that
  // space, so it's identical whether the cached thumbnail or the full-res
  // image is showing. Without this the box would track each bitmap's natural
  // size and visibly jump (small thumbnail -> larger full-res), and the morph
  // would aim at the wrong final size. ``width`` is the binding constraint of:
  // the available width, the width at which height fills the available
  // height, and the image's own width (so small images stay their natural size
  // and never upscale into a blurry full-screen blob). ``height: auto``
  // derives the rest from the width/height attributes' aspect ratio.
  const ratioWH = file.width && file.height ? file.width / file.height : null;
  const sizeStyle =
    ratioWH && file.width
      ? {
          width: `min(calc(${availW}), calc(${ratioWH.toFixed(4)} * (${availH})), ${String(file.width)}px)`,
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
      style={{
        viewTransitionName: MEDIA_VT_NAME,
        maxHeight: `calc(${availH})`,
        maxWidth: `calc(${availW})`,
        ...sizeStyle,
      }}
      className="block select-none rounded-2xl object-contain shadow-2xl"
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
      <div className="flex size-full items-center justify-center p-4 sm:p-6">
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
  // The panel already clips and rounds it, and the chrome is out of the way,
  // so the PDF gets the whole surface.
  return <iframe src={blobUrl} title={file.filename} className="size-full bg-white" />;
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
  // (no nested card/border). ``bg-card`` keeps Shiki tokens readable in both
  // themes (they follow the page's .dark class).
  return (
    <div className="size-full overflow-auto bg-card text-card-foreground">
      <div className="min-h-full px-5 pb-10 pt-6 sm:px-8">
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

import { useState, type CSSProperties, type ReactElement } from "react";
import {
  ArrowUpRight01Icon,
  Copy01Icon,
  Download01Icon,
  File01Icon,
  FileAudioIcon,
  VolumeMute02Icon,
} from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import { AttachmentViewer } from "@/components/AttachmentViewer";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { autoplay } from "@/components/video/autoplay";
import { getMmFileDownloadUrl, type MmFile } from "@/lib/api";
import {
  stableDownloadUrl,
  stableThumbnailUrl,
} from "@/lib/attachmentUrlCache";
import { canCopyImages, copyImageToClipboard } from "@/lib/clipboardImage";
import { fileDescriptor, isInlinePreviewable } from "@/lib/fileTypes";
import { humanSize } from "@/lib/formatting";
import { errMsg, toast } from "@/lib/toast";
import { openExternal } from "@/lib/desktop";
import {
  closeMediaWithTransition,
  openMediaWithTransition,
} from "@/lib/viewTransition";

function isImage(f: MmFile) {
  return f.content_type.startsWith("image/");
}
function isVideo(f: MmFile) {
  return f.content_type.startsWith("video/");
}
function isAudio(f: MmFile) {
  return f.content_type.startsWith("audio/");
}

export function MessageAttachments({ files }: { files: MmFile[] }) {
  const media = files.filter((f) => isImage(f) || isVideo(f));
  const audios = files.filter(isAudio);
  const others = files.filter((f) => !isImage(f) && !isVideo(f) && !isAudio(f));
  const single = media.length === 1;

  const [viewer, setViewer] = useState<{
    files: MmFile[];
    index: number;
    sourceEl: HTMLElement | null;
  } | null>(null);

  if (files.length === 0) return null;

  return (
    <div className="mt-1 flex flex-col gap-2">
      {media.length > 0 && (
        <div className={single ? undefined : "grid max-w-md grid-cols-2 gap-1.5"}>
          {media.map((f, idx) => (
            <MediaTile
              key={f.file_id}
              file={f}
              single={single}
              onOpen={(el) => {
                openMediaWithTransition(el, () => {
                  setViewer({ files: media, index: idx, sourceEl: el });
                });
              }}
            />
          ))}
        </div>
      )}
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

const MIN_PREVIEW_RATIO = 3 / 4;
const MAX_PREVIEW_RATIO = 2 / 1;
const THUMB = "absolute inset-0 size-full object-cover";

function ImageContextMenu({
  file,
  children,
}: {
  file: MmFile;
  children: ReactElement;
}) {
  const freshUrl = () => getMmFileDownloadUrl(file.file_id).then((r) => r.url);

  const onCopy = () => {
    copyImageToClipboard(freshUrl()).then(
      () => { toast.success("Image copied"); },
      (e: unknown) => { toast.error(errMsg(e, "Could not copy image")); },
    );
  };

  const onSave = () => {
    void (async () => {
      let url: string;
      try {
        url = await freshUrl();
      } catch (e) {
        toast.error(errMsg(e, "Download failed"));
        return;
      }
      let objectUrl: string | null = null;
      try {
        const res = await fetch(url, { mode: "cors", credentials: "omit" });
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        objectUrl = URL.createObjectURL(await res.blob());
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = file.filename;
        a.click();
      } catch {
        await openExternal(url);
      } finally {
        if (objectUrl) {
          const revoke = objectUrl;
          window.setTimeout(() => { URL.revokeObjectURL(revoke); }, 10_000);
        }
      }
    })();
  };

  const onOpen = () => {
    void (async () => {
      try {
        await openExternal(await freshUrl());
      } catch (e) {
        toast.error(errMsg(e, "Could not open image"));
      }
    })();
  };

  return (
    <div
      className="contents"
      onContextMenu={(e) => { e.stopPropagation(); }}
      onPointerDown={(e) => { if (e.pointerType === "touch") e.stopPropagation(); }}
    >
      <ContextMenu>
        <ContextMenuTrigger render={children} />
        <ContextMenuContent className="min-w-44">
          {canCopyImages() && (
            <ContextMenuItem onClick={onCopy}>
              <Icon icon={Copy01Icon} className="size-4" />
              Copy image
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={onSave}>
            <Icon icon={Download01Icon} className="size-4" />
            Save image
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onOpen}>
            <Icon icon={ArrowUpRight01Icon} className="size-4" />
            Open original
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

function singleTileStyle(file: MmFile): CSSProperties {
  const natural =
    file.width && file.height ? file.width / file.height : isVideo(file) ? 16 / 9 : 1;
  const ratio = Math.min(MAX_PREVIEW_RATIO, Math.max(MIN_PREVIEW_RATIO, natural));
  return { aspectRatio: ratio, maxWidth: `${String(Math.min(28, 24 * ratio))}rem` };
}

function MediaTile({
  file,
  single,
  onOpen,
}: {
  file: MmFile;
  single: boolean;
  onOpen: (sourceEl: HTMLElement) => void;
}) {
  const tile = (
    <button
      type="button"
      aria-label={file.filename}
      style={single ? singleTileStyle(file) : { aspectRatio: 1 }}
      onClick={(e) => { onOpen(e.currentTarget); }}
      className="relative block w-full overflow-hidden rounded-xl bg-muted/30 outline-none"
    >
      {isVideo(file) ? <VideoThumb file={file} /> : <ImageThumb file={file} />}
    </button>
  );
  return isImage(file) ? <ImageContextMenu file={file}>{tile}</ImageContextMenu> : tile;
}

function ImageThumb({ file }: { file: MmFile }) {
  const src =
    stableThumbnailUrl(file.file_id, file.thumbnail_url, file.thumbnail_url_expires_at) ??
    stableDownloadUrl(file.file_id, file.download_url, file.download_url_expires_at);
  if (!src) {
    return (
      <div className={`flex items-center justify-center bg-muted ${THUMB}`}>
        <Icon icon={File01Icon} className="size-6 text-muted-foreground" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={file.filename}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={THUMB}
    />
  );
}

function formatClock(seconds: number) {
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

function VideoThumb({ file }: { file: MmFile }) {
  const src =
    stableDownloadUrl(file.file_id, file.download_url, file.download_url_expires_at) ?? undefined;
  const [left, setLeft] = useState(Math.ceil((file.duration_ms ?? 0) / 1000));
  return (
    <>
      <video
        key={src}
        ref={autoplay}
        src={src}
        poster={
          stableThumbnailUrl(file.file_id, file.thumbnail_url, file.thumbnail_url_expires_at) ??
          undefined
        }
        muted
        loop
        playsInline
        preload="none"
        onTimeUpdate={({ currentTarget: { duration, currentTime } }) => {
          setLeft(Math.ceil(duration - currentTime));
        }}
        className={THUMB}
      />
      <span className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/50 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
        <Icon icon={VolumeMute02Icon} className="size-3" />
        {Number.isFinite(left) && left > 0 && formatClock(left)}
      </span>
    </>
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

function FileCard({ file, onPreview }: { file: MmFile; onPreview: () => void }) {
  const [downloading, setDownloading] = useState(false);
  const desc = fileDescriptor(file.filename, file.content_type);
  const previewable = isInlinePreviewable(file.filename, file.content_type);

  const download = async () => {
    setDownloading(true);
    try {
      const r = await getMmFileDownloadUrl(file.file_id);
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

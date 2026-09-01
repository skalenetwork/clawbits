import { useEffect, useState } from "react";
import { Cancel01Icon, Loading02Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import { fileDescriptor } from "@/lib/fileTypes";
import { humanSize } from "@/lib/formatting";

export type AttachmentChipStatus =
  | "pending"
  | "uploading"
  | "uploaded"
  | "failed";

export interface AttachmentChipFile {
  /** Stable client-side id (uuid) — used for keying and remove callbacks. */
  localId: string;
  file: File;
  status: AttachmentChipStatus;
  /** 0–100 if known; ``null`` if the upload hasn't started or progress
   *  is indeterminate. */
  progress: number | null;
  error?: string;
}

interface AttachmentChipProps {
  attachment: AttachmentChipFile;
  onRemove: (localId: string) => void;
}

/**
 * One pending/in-flight/finished attachment shown in the composer above
 * the textarea. Image files get a thumbnail preview; everything else gets
 * a typed file icon. While uploading, a thin progress bar runs along the
 * bottom of the chip.
 */
export function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
  const { file, status, progress, error } = attachment;
  const isImage = file.type.startsWith("image/");
  const desc = fileDescriptor(file.name, file.type);

  // Object URL for image preview — created once, revoked on unmount so we
  // don't leak blob URLs while the user is uploading many files.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => { URL.revokeObjectURL(url); };
  }, [file, isImage]);

  const showProgressBar = status === "uploading" && progress !== null;
  const isFailed = status === "failed";

  return (
    <div
      data-status={status}
      className="group relative flex h-14 w-56 max-w-full items-center gap-2 overflow-hidden rounded-lg border border-border/60 bg-muted/40 pl-1.5 pr-7 transition-colors hover:bg-muted/60 data-[status=failed]:border-destructive/50 data-[status=failed]:bg-destructive/5"
    >
      {/* Thumb / icon swatch — fixed 11 squared so chips align in a row. */}
      <div className="relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-background/60">
        {isImage && previewUrl ? (
          <img
            src={previewUrl}
            alt=""
            className="size-full object-cover"
            draggable={false}
          />
        ) : (
          <Icon icon={desc.icon} className={`size-5 ${desc.color}`} />
        )}
        {status === "uploading" && (
          <div className="absolute inset-y-0 left-0 flex size-11 items-center justify-center bg-background/55 backdrop-blur-sm">
            <Icon
              icon={Loading02Icon}
              className="size-4 animate-spin text-foreground"
            />
          </div>
        )}
      </div>

      {/* Filename + meta column. Filename truncates, meta stays on one line. */}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="truncate text-xs font-medium text-foreground">
          {file.name}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {isFailed ? error || "Upload failed" : humanSize(file.size)}
        </span>
      </div>

      {/* Remove / cancel button — also serves as cancel for in-flight uploads. */}
      <button
        type="button"
        onClick={() => { onRemove(attachment.localId); }}
        aria-label={`Remove ${file.name}`}
        className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-md bg-background/90 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:opacity-100"
      >
        <Icon icon={Cancel01Icon} className="size-3" />
      </button>

      {showProgressBar && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-150"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}

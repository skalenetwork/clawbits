import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { Icon } from "@/components/Icon";
import type { PendingAttachment } from "@/hooks/useChannelAttachments";
import { fileDescriptor } from "@/lib/fileTypes";
import { humanSize } from "@/lib/formatting";

/** One composer attachment: an image thumbnail or typed file icon, the name
 *  and size, and a hairline progress bar while it uploads. */
export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: (localId: string) => void;
}) {
  const { file, status, progress, error } = attachment;
  const isImage = file.type.startsWith("image/");
  const desc = fileDescriptor(file.name, file.type);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => { URL.revokeObjectURL(url); };
  }, [file, isImage]);

  const failed = status === "failed";

  return (
    <div className={`group relative flex h-10 max-w-48 items-center gap-2 overflow-hidden rounded-[11px] pr-2.5 pl-1 max-md:pr-7 ${failed ? "bg-destructive/10" : "bg-foreground/6"}`}>
      <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-foreground/6">
        {isImage && previewUrl ? (
          <img src={previewUrl} alt="" className="size-full object-cover" draggable={false}/>
        ) : (
          <Icon icon={desc.icon} className={`size-4 ${desc.color}`}/>
        )}
      </span>
      <span className="flex min-w-0 flex-col text-xs leading-[15px]">
        <span className="truncate text-foreground">{file.name}</span>
        <span className={`truncate ${failed ? "text-destructive" : "text-muted-foreground"}`}>
          {failed ? error || "Upload failed" : status === "uploading" ? "Uploading" : humanSize(file.size)}
        </span>
      </span>
      <button
        type="button"
        onClick={() => { onRemove(attachment.localId); }}
        aria-label={`Remove ${file.name}`}
        className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-md bg-background text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 max-md:opacity-100"
      >
        <X className="size-3"/>
      </button>
      {status === "uploading" && progress !== null && (
        <span className="absolute bottom-0 left-0 h-0.5 bg-foreground transition-[width]" style={{ width: `${String(progress)}%` }}/>
      )}
    </div>
  );
}

import { useState } from "react";
import { Download01Icon, File02Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import { AttachmentViewer } from "@/components/AttachmentViewer";
import { getMmFileDownloadUrl, type MmFile } from "@/lib/api";
import { fileDescriptor, isInlinePreviewable } from "@/lib/fileTypes";
import { humanSize, formatRelativeShort } from "@/lib/formatting";
import { toast } from "@/lib/toast";
import { openExternal } from "@/lib/desktop";
import {
  flattenFilePages,
  useChannelFileList,
} from "@/hooks/useChannelFileList";
import { AttachmentTabEmpty } from "./AttachmentTabEmpty";
import { AttachmentTabFooter } from "./AttachmentTabFooter";

/**
 * Non-media attachments (docs, audio, archives, code, …) as a vertical
 * list. Previewable rows open the universal viewer (paging across the
 * file list); the rest download. ``active`` gates the query.
 */
export function FilesTab({ channelId, active }: { channelId: string; active: boolean }) {
  const query = useChannelFileList(channelId, "file", active);
  const files = flattenFilePages(query.data?.pages);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  if (query.isLoading && files.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/50" />
        ))}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <AttachmentTabEmpty
        icon={File02Icon}
        title="No files yet"
        subtitle="Documents and other uploads shared in this chat will appear here."
      />
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        {files.map((file, idx) => (
          <FileRow
            key={file.file_id}
            file={file}
            onOpen={() => { setViewerIndex(idx); }}
          />
        ))}
      </div>
      <AttachmentTabFooter
        hasMore={query.hasNextPage}
        loading={query.isFetchingNextPage}
        onLoadMore={() => { void query.fetchNextPage(); }}
      />
      {viewerIndex !== null && (
        <AttachmentViewer
          files={files}
          initialIndex={viewerIndex}
          onClose={() => { setViewerIndex(null); }}
        />
      )}
    </>
  );
}

function FileRow({ file, onOpen }: { file: MmFile; onOpen: () => void }) {
  const desc = fileDescriptor(file.filename, file.content_type);
  const previewable = isInlinePreviewable(file.filename, file.content_type);

  const doDownload = async () => {
    try {
      const r = await getMmFileDownloadUrl(file.file_id);
      await openExternal(r.url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    }
  };

  const onClick = () => {
    if (previewable) onOpen();
    else void doDownload();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label={file.filename}
      className="group flex cursor-pointer items-center gap-2.5 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:border-border/40 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${desc.tint}`}>
        <Icon icon={desc.icon} className={`size-5 ${desc.color}`} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium text-foreground">{file.filename}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {humanSize(file.size_bytes)} · {formatRelativeShort(file.created_at)}
        </span>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void doDownload();
        }}
        aria-label={`Download ${file.filename}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 max-md:opacity-100"
      >
        <Icon icon={Download01Icon} className="size-4" />
      </button>
    </div>
  );
}

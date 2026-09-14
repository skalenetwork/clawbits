import { useState } from "react";
import { File02Icon } from "@hugeicons/core-free-icons";
import { Download } from "lucide-react";

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
      <div className="flex flex-col gap-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[30px] animate-pulse rounded-md bg-muted/50" />
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
      <div className="flex flex-col">
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
      className="group flex h-[34px] cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors hover:bg-[var(--sb-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
    >
      <span className={`grid size-5 shrink-0 place-items-center rounded-md ${desc.tint}`}>
        <Icon icon={desc.icon} className={`size-3 ${desc.color}`} />
      </span>
      <span className="min-w-0 flex-1 truncate" title={humanSize(file.size_bytes)}>{file.filename}</span>
      <span className="shrink-0 text-[11px] font-normal text-muted-foreground tabular-nums group-hover:hidden max-md:hidden">
        {formatRelativeShort(file.created_at)}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void doDownload();
        }}
        aria-label={`Download ${file.filename}`}
        className="-mr-1 hidden size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground focus-visible:grid group-hover:grid max-md:grid"
      >
        <Download className="size-3.5" />
      </button>
    </div>
  );
}

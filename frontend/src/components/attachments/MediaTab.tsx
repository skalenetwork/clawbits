import { useState } from "react";
import { Image02Icon, PlayCircleIcon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import { AttachmentViewer } from "@/components/AttachmentViewer";
import { type MmFile } from "@/lib/api";
import { stableDownloadUrl, stableThumbnailUrl } from "@/lib/attachmentUrlCache";
import {
  closeMediaWithTransition,
  openMediaWithTransition,
} from "@/lib/viewTransition";
import {
  flattenFilePages,
  useChannelFileList,
} from "@/hooks/useChannelFileList";
import { AttachmentTabEmpty } from "./AttachmentTabEmpty";
import { AttachmentTabFooter } from "./AttachmentTabFooter";

function formatDuration(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m)}:${s.toString().padStart(2, "0")}`;
}

/**
 * Images + videos for a channel in one chronological grid (server ``kind:
 * media``). Tiles open the universal viewer, paging across the whole media
 * set. ``active`` gates the query so an unopened tab doesn't fetch.
 */
export function MediaTab({ channelId, active }: { channelId: string; active: boolean }) {
  const query = useChannelFileList(channelId, "media", active);
  const files = flattenFilePages(query.data?.pages);
  const [viewer, setViewer] = useState<{
    index: number;
    sourceEl: HTMLElement | null;
  } | null>(null);

  if (query.isLoading && files.length === 0) {
    return (
      <div className="grid grid-cols-3 gap-1">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="aspect-square animate-pulse rounded-md bg-muted/50" />
        ))}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <AttachmentTabEmpty
        icon={Image02Icon}
        title="No media yet"
        subtitle="Photos and videos shared in this chat will show up here."
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-3 gap-1">
        {files.map((file, idx) => (
          <MediaTile
            key={file.file_id}
            file={file}
            onOpen={(el) => {
              openMediaWithTransition(el, () => { setViewer({ index: idx, sourceEl: el }); });
            }}
          />
        ))}
      </div>
      <AttachmentTabFooter
        hasMore={query.hasNextPage}
        loading={query.isFetchingNextPage}
        onLoadMore={() => { void query.fetchNextPage(); }}
      />
      {viewer && (
        <AttachmentViewer
          files={files}
          initialIndex={viewer.index}
          onClose={() => {
            closeMediaWithTransition(viewer.sourceEl, () => { setViewer(null); });
          }}
        />
      )}
    </>
  );
}

function MediaTile({
  file,
  onOpen,
}: {
  file: MmFile;
  onOpen: (sourceEl: HTMLElement | null) => void;
}) {
  const isVideo = file.content_type.startsWith("video/");
  // Images carry an inline thumbnail/download URL; videos have no server
  // thumbnail, so they render as a neutral tile with a play glyph.
  const thumb =
    stableThumbnailUrl(file.file_id, file.thumbnail_url, file.thumbnail_url_expires_at) ??
    stableDownloadUrl(file.file_id, file.download_url, file.download_url_expires_at) ??
    null;
  const duration = formatDuration(file.duration_ms);

  return (
    <button
      type="button"
      onClick={(e) => { onOpen(e.currentTarget.querySelector("img")); }}
      className="group relative aspect-square overflow-hidden rounded-md bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={file.filename}
    >
      {thumb && !isVideo ? (
        <img
          src={thumb}
          alt={file.filename}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
        />
      ) : isVideo && thumb ? (
        <img
          src={thumb}
          alt={file.filename}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="size-full object-cover opacity-90"
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          <Icon icon={PlayCircleIcon} className="size-7 text-muted-foreground" />
        </div>
      )}
      {isVideo && (
        <>
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Icon icon={PlayCircleIcon} className="size-8 text-white/90 drop-shadow" />
          </span>
          {duration && (
            <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/60 px-1 py-0.5 text-[10px] font-medium tabular-nums text-white">
              {duration}
            </span>
          )}
        </>
      )}
    </button>
  );
}

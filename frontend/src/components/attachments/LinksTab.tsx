import { useState } from "react";
import { Link01Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import { useLinkPreview } from "@/hooks/useLinkPreview";
import { type MmLinkItem } from "@/lib/api";
import { formatRelativeShort } from "@/lib/formatting";
import { openExternal } from "@/lib/desktop";
import {
  flattenLinkPages,
  useChannelLinks,
} from "@/hooks/useChannelFileList";
import { AttachmentTabEmpty } from "./AttachmentTabEmpty";
import { AttachmentTabFooter } from "./AttachmentTabFooter";

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function faviconOf(url: string): string | null {
  try {
    return `${new URL(url).origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/**
 * URLs shared in the channel, newest first (server scans message bodies).
 * Each row unfurls its OG metadata client-side via ``useLinkPreview`` but
 * always renders at least host + URL so preview-less links aren't dropped.
 */
export function LinksTab({ channelId, active }: { channelId: string; active: boolean }) {
  const query = useChannelLinks(channelId, active);
  const links = flattenLinkPages(query.data?.pages);

  if (query.isLoading && links.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-[30px] animate-pulse rounded-md bg-muted/50" />
        ))}
      </div>
    );
  }

  if (links.length === 0) {
    return (
      <AttachmentTabEmpty
        icon={Link01Icon}
        title="No links yet"
        subtitle="Links shared in this chat will be collected here."
      />
    );
  }

  return (
    <>
      <div className="flex flex-col">
        {links.map((link) => (
          <LinkRow key={`${String(link.post_id)}:${link.url}`} link={link} />
        ))}
      </div>
      <AttachmentTabFooter
        hasMore={query.hasNextPage}
        loading={query.isFetchingNextPage}
        onLoadMore={() => { void query.fetchNextPage(); }}
      />
    </>
  );
}

function LinkRow({ link }: { link: MmLinkItem }) {
  const { data } = useLinkPreview(link.url);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const host = hostOf(link.url);
  const trimmedTitle = data?.title?.trim();
  const title = trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : host;
  const favicon = !faviconFailed ? faviconOf(link.url) : null;

  return (
    <button
      type="button"
      onClick={() => { void openExternal(data?.canonical_url ?? link.url); }}
      title={host}
      className="flex h-[34px] items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors hover:bg-[var(--sb-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
    >
      <span className="grid size-5 shrink-0 place-items-center overflow-hidden rounded-md bg-foreground/6">
        {favicon ? (
          <img
            src={favicon}
            alt=""
            width={14}
            height={14}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => { setFaviconFailed(true); }}
            className="size-3.5 rounded-sm"
          />
        ) : (
          <Icon icon={Link01Icon} className="size-3 text-muted-foreground" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="shrink-0 text-[11px] font-normal text-muted-foreground tabular-nums">
        {formatRelativeShort(link.post_created_at)}
      </span>
    </button>
  );
}

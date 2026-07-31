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
      <div className="flex flex-col gap-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/50" />
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
      <div className="flex flex-col gap-1">
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
      className="group flex items-center gap-2.5 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:border-border/40 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/60">
        {favicon ? (
          <img
            src={favicon}
            alt=""
            width={18}
            height={18}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => { setFaviconFailed(true); }}
            className="size-[18px] rounded-sm"
          />
        ) : (
          <Icon icon={Link01Icon} className="size-5 text-muted-foreground" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {host} · {formatRelativeShort(link.post_created_at)}
        </span>
      </div>
    </button>
  );
}

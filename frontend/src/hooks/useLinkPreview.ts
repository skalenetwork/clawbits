import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchLinkPreview, type LinkPreviewData } from "@/lib/api";
import {
  forgetNoPreview,
  isKnownNoPreview,
  rememberNoPreview,
} from "@/lib/linkPreviewCache";
import { queryKeys } from "@/lib/queryKeys";

/** React Query–backed unfurl. Returns the preview payload plus a
 *  ``isLoading`` flag so callers can distinguish "still fetching"
 *  from "loaded, no usable data" — the LinkPreviewCard uses this
 *  to render a height-reserved skeleton while the request is in
 *  flight, preventing a layout jump when the card content arrives.
 *
 *  Stale-time is one hour on top of the server's Redis cache (24h on
 *  success, 5min on failure). OG metadata for a given URL doesn't
 *  meaningfully change inside a single chat session. */
export function useLinkPreview(url: string): {
  data: LinkPreviewData | null;
  isLoading: boolean;
} {
  // Once a URL has unfurled to "no usable card", remember that across
  // reloads and stop re-attempting. Without this, every cold load of a
  // channel with a dead / preview-less link re-fires the (often slow,
  // doomed) fetch and flashes a loading skeleton each time the channel
  // is opened. Re-evaluated per URL.
  const knownNoPreview = useMemo(() => isKnownNoPreview(url), [url]);

  const query = useQuery({
    queryKey: queryKeys.mm.linkPreview(url),
    enabled: url.length > 0 && !knownNoPreview,
    queryFn: async () => {
      const data = await fetchLinkPreview(url);
      // Write-through the verdict so the next cold load can skip the
      // fetch + skeleton entirely. "No usable card" == server error or
      // no title, mirroring LinkPreviewCard's own render gate.
      if (data.error || !data.title) rememberNoPreview(url);
      else forgetNoPreview(url);
      return data;
    },
    staleTime: 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
    // The server returns 200 with ``error`` set even when the upstream
    // fetch fails, so we don't need network retry logic here. The only
    // failure mode is the local request itself (auth, no network) —
    // one retry is plenty.
    retry: 1,
  });
  // A disabled (known-miss) query reports no data and isn't loading, so
  // the card renders nothing — no skeleton, no network request.
  return { data: query.data ?? null, isLoading: query.isLoading };
}

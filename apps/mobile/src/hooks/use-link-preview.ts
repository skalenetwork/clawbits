import { useQuery } from '@tanstack/react-query';

import { fetchLinkPreview, type LinkPreviewData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

/** React Query–backed unfurl. Returns ``null`` while loading or when
 *  the user is unauthenticated; otherwise resolves to the server's
 *  preview payload (which itself may carry ``error`` instead of data).
 *
 *  Stale-time is effectively infinite — the server already caches the
 *  result in Redis with a long TTL, and the OG metadata for a given
 *  URL doesn't meaningfully change inside a single chat session. */
export function useLinkPreview(url: string): LinkPreviewData | null {
  const { token } = useAuth();
  const query = useQuery({
    queryKey: ['link-preview', url],
    enabled: token != null && url.length > 0,
    queryFn: () => fetchLinkPreview(token, url),
    staleTime: 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
    // The server returns 200 with ``error`` set even when the upstream
    // fetch fails, so we don't need network retry logic here. The only
    // failure mode is the local request itself (auth, no network) —
    // one retry is plenty.
    retry: 1,
  });
  return query.data ?? null;
}

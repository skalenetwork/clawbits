import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type {
  PersistedClient,
  PersistQueryClientOptions,
} from '@tanstack/react-query-persist-client';

const PERSIST_KEY = 'clawbits.query-cache.v1';
const ONE_DAY = 1000 * 60 * 60 * 24;

// Bumped when the on-disk cache shape becomes incompatible. PersistClient
// silently drops the stored cache when the buster changes, which is the
// official way to evict everything in one go.
const CACHE_BUSTER = '1';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      // gcTime must outlive maxAge or rehydrated queries get GC'd before
      // any consumer mounts and re-uses them.
      gcTime: ONE_DAY * 7,
    },
  },
});

const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: PERSIST_KEY,
  // AsyncStorage on RN handles strings fine; throttle the writes so a
  // burst of SSE events doesn't hammer the disk.
  throttleTime: 1000,
  // Strip optimistic / failed temp posts (negative ``post_id``) before
  // anything reaches disk. Otherwise a send that failed — patched to
  // ``_failed`` but kept with its negative id — gets dehydrated into the
  // ``mm-posts`` cache and rehydrates after a restart as a permanent,
  // inert ghost that no server data ever reconciles away. Same for an
  // in-flight optimistic post caught by the throttled write mid-send.
  serialize: (client) => JSON.stringify(stripTempPosts(client)),
});

/** Remove optimistic/failed temp posts (negative ``post_id``) from the
 *  ``mm-posts`` infinite-query caches in a dehydrated client, without
 *  mutating the live cache objects (we clone only the path we touch). */
function stripTempPosts(client: PersistedClient): PersistedClient {
  const queries = client.clientState.queries.map((query) => {
    if (query.queryKey?.[0] !== 'mm-posts') return query;
    const data = query.state?.data as
      | { pages?: { posts?: { post_id: number }[] }[] }
      | undefined;
    if (!data?.pages) return query;
    const pages = data.pages.map((page) =>
      page?.posts
        ? { ...page, posts: page.posts.filter((p) => p.post_id >= 0) }
        : page,
    );
    return { ...query, state: { ...query.state, data: { ...data, pages } } };
  });
  return { ...client, clientState: { ...client.clientState, queries } };
}

export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister,
  maxAge: ONE_DAY * 7,
  buster: CACHE_BUSTER,
  dehydrateOptions: {
    shouldDehydrateQuery: (query) =>
      query.state.status === 'success' && shouldPersist(query.queryKey),
  },
};

/** Allow-list of query keys safe to round-trip through disk. Keep this
 *  conservative — anything tied to a single render pass (typing
 *  indicators, ephemeral counters) has no business surviving a restart. */
function shouldPersist(key: readonly unknown[]): boolean {
  const head = key[0];
  return (
    head === 'channels' ||
    head === 'mm-posts' ||
    head === 'mm-channel-members' ||
    head === 'orgs'
  );
}

import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import {
  focusManager,
  onlineManager,
  QueryClient,
  useInfiniteQuery,
  useIsRestoring,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api, apiUrl, ApiError, channelPath } from "./api";
import {
  historyPosts,
  mergePost,
  reconcilePage,
  removePost,
  type ChatEvent,
  type History,
  type Post,
} from "./models";
import { useSession } from "./session";
import { stream } from "./stream";

export const historyKey = (channel: string) => ["history", channel] as const;

export function DataProvider({ children }: { children: ReactNode }) {
  const { session, signOut } = useSession();
  const onUnauthorized = useEffectEvent(signOut);
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 86_400_000,
            retry: (count, error) =>
              count < 1 && !(error instanceof ApiError && error.status < 500),
          },
          mutations: { retry: false },
        },
      }),
  );
  const [persistence] = useState(() => {
    let active = true;
    let writing = Promise.resolve();
    const persister = createAsyncStoragePersister({
      key: `clawbits.history.v2.${apiUrl}.${session!.user.id}`,
      throttleTime: 1000,
      storage: {
        ...AsyncStorage,
        setItem: (name, value) => {
          writing = writing
            .catch(() => undefined)
            .then(() =>
              active ? AsyncStorage.setItem(name, value) : undefined,
            );
          return writing;
        },
      },
      serialize: (cache) =>
        JSON.stringify({
          ...cache,
          clientState: {
            ...cache.clientState,
            queries: cache.clientState.queries.map((query) => {
              if (query.queryKey[0] !== "history") return query;
              const data = query.state.data as History;
              return {
                ...query,
                state: {
                  ...query.state,
                  data: {
                    pages: data.pages.slice(0, 4),
                    pageParams: data.pageParams.slice(0, 4),
                  },
                },
              };
            }),
          },
        }),
    });
    return {
      persister,
      open: () => {
        active = true;
      },
      close: async () => {
        active = false;
        await writing.catch(() => undefined);
        await persister.removeClient();
      },
    };
  });

  useEffect(() => {
    persistence.open();
    const errors = client.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "error" &&
        event.action.error instanceof ApiError &&
        event.action.error.status === 401
      )
        onUnauthorized();
    });
    const app = AppState.addEventListener("change", (state) =>
      focusManager.setFocused(state === "active"),
    );
    const network = NetInfo.addEventListener((state) =>
      onlineManager.setOnline(
        state.isConnected !== false && state.isInternetReachable !== false,
      ),
    );
    return () => {
      errors();
      app.remove();
      network();
      client.clear();
      void persistence.close();
    };
  }, [client, persistence]);

  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{
        persister: persistence.persister,
        maxAge: 86_400_000,
        buster: "1",
        dehydrateOptions: {
          shouldDehydrateQuery: (query) =>
            query.state.status === "success" &&
            ["orgs", "channels", "history", "channel"].includes(
              String(query.queryKey[0]),
            ),
        },
      }}
    >
      <GlobalEvents />
      {children}
    </PersistQueryClientProvider>
  );
}

export function useOrganizations() {
  const { session } = useSession();
  const query = useQuery({
    queryKey: ["orgs"],
    queryFn: ({ signal }) => api.organizations(session!.token, signal),
  });
  const organizations = query.data?.organizations ?? [];
  const selected =
    organizations.find((org) => org.org_id === session?.org) ??
    organizations.find((org) => org.is_personal) ??
    organizations[0];
  return { ...query, organizations, selected };
}

export function useHistory(id: string) {
  const { session } = useSession();
  const client = useQueryClient();
  return useInfiniteQuery({
    queryKey: historyKey(id),
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam, signal }) => {
      const before = historyPosts(client.getQueryData<History>(historyKey(id)));
      const page = await api.posts(session!.token, id, pageParam, signal);
      const current = historyPosts(
        client.getQueryData<History>(historyKey(id)),
      );
      return reconcilePage(
        {
          ...page,
          next: page.posts.length === 50 ? page.posts.at(-1)!.post_id : null,
        },
        before,
        current,
        pageParam === null,
      );
    },
    getNextPageParam: (page) => page.next ?? undefined,
  });
}

function GlobalEvents() {
  useLiveEvents();
  return null;
}

export function useLiveEvents(channel?: string, enabled = true): boolean {
  const { session, signOut } = useSession();
  const client = useQueryClient();
  const restoring = useIsRestoring();
  const token = session?.token;
  const [connected, setConnected] = useState(false);
  const unauthorized = useEffectEvent(signOut);

  useEffect(() => {
    if (!token || restoring || !enabled) return;
    let controller: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let disposed = false;
    const updates = new Map<number, Post>();
    const invalidate = () => {
      void client.invalidateQueries({
        queryKey: channel ? historyKey(channel) : ["channels"],
      });
      if (channel)
        void client.invalidateQueries({ queryKey: ["channel", channel] });
    };
    const event = (incoming: ChatEvent) => {
      if (
        incoming.type === "post.created" ||
        incoming.type === "post.updated"
      ) {
        updates.set(incoming.data.post_id, incoming.data);
        if (!flush)
          flush = setTimeout(() => {
            const posts = [...updates.values()];
            updates.clear();
            flush = undefined;
            for (const post of posts)
              client.setQueryData<History>(
                historyKey(post.channel_id),
                (old) => (old || channel ? mergePost(old, post) : old),
              );
            if (!channel || posts.some((post) => post.status === "published"))
              void client.invalidateQueries({ queryKey: ["channels"] });
          }, 50);
      } else if (incoming.type === "post.deleted") {
        updates.delete(incoming.data.post_id);
        client.setQueryData<History>(historyKey(incoming.channel_id), (old) =>
          old ? removePost(old, incoming.data.post_id) : old,
        );
      } else if (incoming.type === "channel.removed") {
        client.removeQueries({ queryKey: historyKey(incoming.channel_id) });
        void client.invalidateQueries({
          queryKey: ["channel", incoming.channel_id],
        });
        void client.invalidateQueries({ queryKey: ["channels"] });
      } else if (incoming.type.startsWith("channel."))
        void client.invalidateQueries({ queryKey: ["channels"] });
    };
    const stop = () => {
      controller?.abort();
      controller = undefined;
      clearTimeout(retry);
      retry = undefined;
      clearTimeout(flush);
      flush = undefined;
      updates.clear();
      setConnected(false);
    };
    const start = () => {
      if (
        disposed ||
        controller ||
        !onlineManager.isOnline() ||
        AppState.currentState !== "active"
      )
        return;
      const attempt = new AbortController();
      controller = attempt;
      let denied = false;
      void stream(
        channel ? `${channelPath(channel)}/events` : "/api/human/events",
        token,
        attempt.signal,
        () => {
          failures = 0;
          setConnected(true);
          invalidate();
        },
        event,
      )
        .catch((error: unknown) => {
          if (
            error instanceof ApiError &&
            [401, 403, 404].includes(error.status)
          ) {
            denied = true;
            if (error.status === 401) unauthorized();
            else if (channel) {
              client.removeQueries({ queryKey: historyKey(channel) });
              invalidate();
            }
          }
        })
        .finally(() => {
          if (disposed || attempt.signal.aborted) return;
          controller = undefined;
          setConnected(false);
          if (!denied)
            retry = setTimeout(
              start,
              Math.min(30_000, 1000 * 2 ** failures++) + Math.random() * 250,
            );
        });
    };
    const app = AppState.addEventListener("change", (state) =>
      state === "active" ? start() : stop(),
    );
    const network = onlineManager.subscribe((online) =>
      online ? start() : stop(),
    );
    start();
    return () => {
      disposed = true;
      stop();
      app.remove();
      network();
    };
  }, [channel, client, enabled, restoring, token]);
  return connected;
}

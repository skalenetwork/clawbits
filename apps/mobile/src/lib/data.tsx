import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import {
  focusManager,
  notifyManager,
  onlineManager,
  QueryClient,
  useInfiniteQuery,
  useIsRestoring,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { Alert, AppState } from "react-native";
import { api, apiUrl, ApiError, channelPath } from "./api";
import { endChannelTurns, memberStatus, presenceSnapshot, replyPublished } from "./liveTurn";
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
import {
  activeWidgetsKey,
  applyWidget,
  applyWidgetEvent,
  freshActiveWidgets,
  freshWidget,
  widgetKey,
  type Widget,
  type WidgetAction,
} from "./widgets";

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
    (session?.org ? organizations[0] : undefined);
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
      if (channel) {
        void client.invalidateQueries({ queryKey: ["channel", channel] });
        // The bus keeps no history: a widget may have moved while the stream was down.
        void client.invalidateQueries({ queryKey: activeWidgetsKey(channel) });
        void client.invalidateQueries({ queryKey: ["widget"] });
      }
    };
    const streamed = (post: Post) =>
      (
        updates.get(post.post_id) ??
        historyPosts(
          client.getQueryData<History>(historyKey(post.channel_id)),
        ).find((known) => known.post_id === post.post_id)
      )?.status === "streaming";
    /** Writes the pending posts to the cache, and ends the turn a reply finished in the same notify batch, so the
     *  published post and the turn's end reach React in one render. */
    const commit = (reply?: Post) => {
      clearTimeout(flush);
      flush = undefined;
      const posts = [...updates.values()];
      updates.clear();
      notifyManager.batch(() => {
        for (const post of posts)
          client.setQueryData<History>(
            historyKey(post.channel_id),
            (old) => (old || channel ? mergePost(old, post) : old),
          );
        if (reply)
          notifyManager.schedule(() => {
            replyPublished(reply);
          });
      });
      if (!channel || posts.some((post) => post.status === "published"))
        void client.invalidateQueries({ queryKey: ["channels"] });
    };
    /** Folds a live-lane event behind what the cache has queued, so the agent's status that follows its reply cannot
     *  end the turn before the reply does. */
    const inOrder = (fold: () => void) => {
      notifyManager.schedule(() => {
        if (!disposed) fold();
      });
    };
    const event = (incoming: ChatEvent) => {
      if (
        incoming.type === "post.created" ||
        incoming.type === "post.updated"
      ) {
        const post = incoming.data;
        const reply =
          !!channel &&
          !!post.agent_id &&
          post.status === "published" &&
          streamed(post);
        updates.set(post.post_id, post);
        if (reply) commit(post);
        else flush ??= setTimeout(commit, 50);
      } else if (incoming.type === "post.deleted") {
        updates.delete(incoming.data.post_id);
        client.setQueryData<History>(historyKey(incoming.channel_id), (old) =>
          old ? removePost(old, incoming.data.post_id) : old,
        );
      } else if (channel && incoming.type === "member.status") {
        const status = incoming.data;
        inOrder(() => {
          memberStatus(channel, status);
        });
      } else if (channel && incoming.type === "presence.snapshot") {
        const { members } = incoming.data;
        inOrder(() => {
          presenceSnapshot(channel, members);
        });
      } else if (incoming.type === "widget.updated") {
        applyWidgetEvent(client, incoming.data);
      } else if (incoming.type === "widget.turn") {
        void client.invalidateQueries({ queryKey: ["channels"] });
      } else if (incoming.type === "channel.widgets") {
        void client.invalidateQueries({ queryKey: ["channel", incoming.channel_id] });
        void client.invalidateQueries({ queryKey: ["channels"] });
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

  useEffect(() => {
    if (!channel) return;
    return () => {
      endChannelTurns(channel);
    };
  }, [channel]);
  return connected;
}

/** One widget; `widget.updated` keeps it live, so no polling. A slow answer never undoes a newer rev an event brought
 *  while it was out. */
export function useWidget(id: string) {
  const { session } = useSession();
  const client = useQueryClient();
  return useQuery({
    queryKey: widgetKey(id),
    queryFn: async ({ signal }) => freshWidget(client, await api.widget(session!.token, id, signal)),
    staleTime: 60_000,
  });
}

/** The chat's active widget, if any (the server allows one), for the dock. */
export function useActiveWidgets(channel: string, enabled: boolean) {
  const { session } = useSession();
  const client = useQueryClient();
  return useQuery({
    queryKey: activeWidgetsKey(channel),
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const { widgets } = await api.activeWidgets(session!.token, channel, signal);
      return freshActiveWidgets(client, widgets);
    },
  });
}

/** Act as the viewer's seat. A refused action refetches, since the scene it was taken on may be stale. */
export function useWidgetAction() {
  const { token } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ widget, action }: { widget: Widget; action: WidgetAction }) =>
      api.actOnWidget(token() ?? "", widget.widget_id, action, widget.rev),
    onSuccess: (fresh) => {
      applyWidget(client, fresh);
    },
    onError: (error, { widget }) => {
      Alert.alert("That didn't go through", error instanceof Error ? error.message : undefined);
      void client.invalidateQueries({ queryKey: widgetKey(widget.widget_id) });
      void client.invalidateQueries({ queryKey: activeWidgetsKey(widget.channel_id) });
    },
  });
}

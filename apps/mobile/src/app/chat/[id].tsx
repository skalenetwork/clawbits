import {
  KeyboardAwareLegendList,
} from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { randomUUID } from "expo-crypto";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
} from "react";
import {
  AppState,
  DynamicColorIOS,
  Linking,
  PlatformColor,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { GlassView } from "expo-glass-effect";
import {
  KeyboardStickyView,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDerivedValue, useSharedValue } from "react-native-reanimated";
import { api, ApiError } from "@/lib/api";
import { historyKey, useHistory, useLiveEvents } from "@/lib/data";
import { glyphKind, isPairChannel } from "@/lib/chatFilters";
import {
  backUnreadTitle,
  inboxUnread,
  samePerson,
  showStamp,
  stampLabel,
} from "@/lib/messageLayout";
import {
  channelName,
  historyPosts,
  mergePost,
  type Channel,
  type History,
  type Post,
} from "@/lib/models";
import { useSession } from "@/lib/session";
import {
  AvatarView,
  color,
  Empty,
  GlassButton,
  GlassComposer,
  styles,
  type GlassComposerHandle,
} from "@/components/ui";

type Delivery = { uuid: string; text: string; state: "sending" | "uncertain" };

function itemsAreEqual(prev: Post, next: Post) {
  return (
    prev.post_id === next.post_id &&
    prev.message === next.message &&
    prev.status === next.status &&
    prev.updated_at === next.updated_at
  );
}

export default function ConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Conversation key={id} id={id} />;
}

function Conversation({ id }: { id: string }) {
  const { session } = useSession();
  const token = session!.token;
  const org = session!.org ?? "";
  const client = useQueryClient();
  const channel = useQuery({
    queryKey: ["channel", id],
    queryFn: ({ signal }) => api.channel(token, id, signal),
  });
  const inbox = useQuery({
    queryKey: ["channels", org],
    enabled: !!org,
    queryFn: ({ signal }) => api.channels(token, org, signal),
  });
  const history = useHistory(id);
  const focused = useIsFocused();
  const connected = useLiveEvents(id, focused);
  const insets = useSafeAreaInsets();
  const listPad = useMemo(
    () => ({ paddingTop: insets.top + 44, paddingBottom: 0 }),
    [insets.top],
  );
  const list = useRef<LegendListRef>(null);
  const composer = useRef<ComponentRef<typeof View>>(null);
  const field = useRef<GlassComposerHandle>(null);
  const composerSize = useSharedValue(56 + insets.bottom);
  const lastComposer = useRef(0);
  const { progress } = useReanimatedKeyboardAnimation();
  const bottomInset = insets.bottom;
  const closedDrop = 16;
  const contentInsetEndAdjustment = useDerivedValue(
    () =>
      composerSize.value -
      closedDrop * (1 - progress.value) -
      bottomInset * progress.value,
  );
  const onComposerLayout = (event: LayoutChangeEvent) => {
    const height = Math.round(event.nativeEvent.layout.height);
    if (!Number.isFinite(height) || height <= 0) return;
    if (lastComposer.current === 0) {
      lastComposer.current = height;
      composerSize.value = height;
      return;
    }
    if (Math.abs(height - lastComposer.current) < 8) return;
    lastComposer.current = height;
    composerSize.value = height;
  };
  const posts = useMemo(() => historyPosts(history.data), [history.data]);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useRef(0);
  const sending = useRef(false);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedRef = useRef(focused);
  const connectedRef = useRef(connected);
  focusedRef.current = focused;
  connectedRef.current = connected;
  const cached = inbox.data?.channels.find((item) => item.channel_id === id);
  const active = channel.data ?? cached;
  const named = active != null && !isPairChannel(active);
  const userId = session!.user.id;
  const forbidden =
    channel.error instanceof ApiError &&
    [403, 404].includes(channel.error.status);
  const scheduleRead = useCallback(() => {
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      if (
        !focusedRef.current ||
        !connectedRef.current ||
        AppState.currentState !== "active"
      )
        return;
      const state = list.current?.getState();
      if (!state) return;
      let max = read.current;
      for (let i = state.start; i <= state.end; i++) {
        const post = posts[i];
        if (post?.status === "published") max = Math.max(max, post.post_id);
      }
      if (max <= read.current) return;
      void api
        .read(token, id, max)
        .then((result) => {
          read.current = Math.max(read.current, result.last_read_post_id);
          void client.invalidateQueries({ queryKey: ["channels"] });
        })
        .catch(() => undefined);
    }, 400);
  }, [client, id, posts, token]);
  const renderItem = useCallback(
    ({ item, index }: { item: Post; index: number }) => (
      <Message
        post={item}
        previous={posts[index - 1]}
        next={posts[index + 1]}
        own={item.human_id === userId}
        named={named}
      />
    ),
    [named, posts, userId],
  );
  const getItemType = useCallback(
    (item: Post, index: number) =>
      showStamp(item, posts[index - 1]) ? "stamp" : "row",
    [posts],
  );

  useEffect(
    () => () => {
      if (readTimer.current) clearTimeout(readTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (forbidden) client.removeQueries({ queryKey: historyKey(id) });
  }, [client, forbidden, id]);

  const accepted =
    !!delivery && posts.some((post) => post.client_msg_uuid === delivery.uuid);
  const pending = accepted ? null : delivery;
  const title = active ? channelName(active) : "";
  const backTitle =
    backUnreadTitle(inboxUnread(inbox.data?.channels ?? [])) ?? "Chats";
  const renderTitle = useCallback(
    () => (active ? <ChatTitle channel={active} /> : null),
    [active],
  );
  const header = useMemo(
    () => ({
      title,
      headerTransparent: true,
      headerShadowVisible: false,
      headerBlurEffect: "none" as const,
      headerStyle: { backgroundColor: "transparent" },
      headerBackButtonDisplayMode: "default" as const,
      headerBackTitle: backTitle,
      headerTitle: active ? renderTitle : undefined,
      scrollEdgeEffects: {
        top: "hidden" as const,
        bottom: "hidden" as const,
        left: "hidden" as const,
        right: "hidden" as const,
      },
    }),
    [active, backTitle, renderTitle, title],
  );

  const send = async (message: string) => {
    if (!message || sending.current || pending || !connected) return;
    sending.current = true;
    const uuid = randomUUID();
    setDelivery({ uuid, text: message, state: "sending" });
    setError(null);
    try {
      const post = await api.send(token, id, message, uuid);
      client.setQueryData<History>(historyKey(id), (old) =>
        mergePost(old, post),
      );
      setDelivery(null);
      void client.invalidateQueries({ queryKey: ["channels"] });
    } catch (cause) {
      const accepted = historyPosts(
        client.getQueryData<History>(historyKey(id)),
      ).some((post) => post.client_msg_uuid === uuid);
      if (accepted) setDelivery(null);
      else if (cause instanceof ApiError && cause.status < 500) {
        setDelivery(null);
        void field.current?.setText(message);
        setError(cause.message);
      } else {
        setDelivery({ uuid, text: message, state: "uncertain" });
        setError(
          "Delivery unconfirmed. Check the conversation before sending again.",
        );
        void history.refetch();
      }
    } finally {
      sending.current = false;
    }
  };

  if (forbidden)
    return (
      <>
        <Stack.Screen options={{ title: "Chat", headerBackTitle: "Chats" }} />
        <Empty
          title="Conversation unavailable"
          detail="You may no longer have access."
          onRetry={() => router.back()}
        />
      </>
    );
  return (
    <>
      {history.isPending ? (
        <Empty
          title="No saved messages"
          loading={history.fetchStatus === "fetching"}
          detail="Connect to load this conversation."
        />
      ) : history.isError && !history.data ? (
        <Empty
          title="Could not load messages"
          onRetry={() => {
            void history.refetch();
          }}
        />
      ) : (
        <KeyboardAwareLegendList
          ref={list}
          style={chat.list}
          data={posts}
          keyExtractor={keyExtractor}
          estimatedItemSize={64}
          renderItem={renderItem}
          getItemType={getItemType}
          itemsAreEqual={itemsAreEqual}
          initialScrollAtEnd
          alignItemsAtEnd
          maintainScrollAtEnd={{
            animated: false,
            on: { dataChange: true, layout: false, itemLayout: false },
          }}
          maintainVisibleContentPosition={{ data: true, size: true }}
          contentInsetAdjustmentBehavior="never"
          contentInsetEndAdjustment={contentInsetEndAdjustment}
          keyboardLiftBehavior="always"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          drawDistance={400}
          contentContainerStyle={listPad}
          onStartReached={() => {
            if (history.hasNextPage && !history.isFetching)
              void history.fetchNextPage();
          }}
          onStartReachedThreshold={1}
          onMomentumScrollEnd={scheduleRead}
          onScrollEndDrag={scheduleRead}
          ListHeaderComponent={
            history.isFetchNextPageError ? (
              <GlassButton
                label="Retry older messages"
                onPress={() => {
                  void history.fetchNextPage();
                }}
              />
            ) : !connected && posts.length === 0 ? (
              <Text
                accessibilityLiveRegion="polite"
                style={[styles.detail, { padding: 6 }]}
              >
                Connecting · Saved messages available
              </Text>
            ) : null
          }
          ListFooterComponent={
            pending ? (
              <View
                style={[chat.row, chat.ungrouped, { alignItems: "flex-end" }]}
              >
              <View style={chat.bubbleWrap}>
                <View
                  style={[
                    chat.bubble,
                    chat.outgoing,
                    bubbleShape(true, false, false),
                  ]}
                >
                  <Text style={[chat.message, chat.outgoingText]}>
                    {pending.text}
                  </Text>
                </View>
                <BubbleTail own />
              </View>
                <Text style={chat.author}>
                  {pending.state === "sending"
                    ? "Sending…"
                    : "Delivery unconfirmed"}
                </Text>
              </View>
            ) : null
          }
        />
      )}
      <KeyboardStickyView
        style={chat.sticky}
        offset={{ closed: 16, opened: insets.bottom }}
      >
        <View
          ref={composer}
          onLayout={onComposerLayout}
          style={{ paddingBottom: insets.bottom + 8, paddingTop: 8 }}
        >
          {error && !accepted && (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {error}
            </Text>
          )}
          {pending?.state === "uncertain" && (
            <GlassButton
              label="Keep text in composer"
              onPress={() => {
                void field.current?.setText(pending.text);
                setDelivery(null);
                setError(null);
              }}
            />
          )}
          <GlassComposer
            composerRef={field}
            onSend={(message) => {
              void send(message);
            }}
            sendDisabled={!connected || !!pending}
          />
        </View>
      </KeyboardStickyView>
      <Stack.Screen options={header} />
    </>
  );
}

function ChatTitle({ channel }: { channel: Channel }) {
  const name = channelName(channel);
  const shape = glyphKind(channel);
  return (
    <GlassView
      glassEffectStyle="regular"
      accessibilityLabel={name}
      style={title.pill}
    >
      <AvatarView
        size={28}
        name={name}
        shape={shape}
        avatar={
          shape === "channel"
            ? channel.avatar
            : channel.dm_peer?.avatar || channel.avatar
        }
      />
      <Text numberOfLines={1} style={title.name}>
        {name}
      </Text>
    </GlassView>
  );
}

function bubbleShape(own: boolean, groupedPrev: boolean, groupedNext: boolean) {
  const outer = 18;
  const inner = 5;
  const stem = groupedNext ? inner : 5;
  if (own) {
    return {
      borderTopLeftRadius: outer,
      borderBottomLeftRadius: outer,
      borderTopRightRadius: groupedPrev ? inner : outer,
      borderBottomRightRadius: stem,
    };
  }
  return {
    borderTopRightRadius: outer,
    borderBottomRightRadius: outer,
    borderTopLeftRadius: groupedPrev ? inner : outer,
    borderBottomLeftRadius: stem,
  };
}

function BubbleTail({ own }: { own: boolean }) {
  const fill = own ? bubbleOut : bubbleIn;
  return (
    <View
      pointerEvents="none"
      style={[chat.tail, own ? chat.tailOut : chat.tailIn]}
    >
      <View
        style={[
          chat.tailNub,
          own ? chat.tailNubOut : chat.tailNubIn,
          { backgroundColor: fill },
        ]}
      />
      <View
        style={[chat.tailScoop, own ? chat.tailScoopOut : chat.tailScoopIn]}
      />
    </View>
  );
}

function BubbleText({ text, own }: { text: string; own: boolean }) {
  if (!text.includes("http")) {
    return (
      <Text style={[chat.message, own ? chat.outgoingText : chat.incomingText]}>
        {text}
      </Text>
    );
  }
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <Text style={[chat.message, own ? chat.outgoingText : chat.incomingText]}>
      {parts.map((part, index) =>
        /^https?:\/\//.test(part) ? (
          <Text
            key={index}
            style={chat.link}
            onPress={() => {
              void Linking.openURL(part);
            }}
          >
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

const Message = memo(function Message({
  post,
  previous,
  next,
  own,
  named,
}: {
  post: Post;
  previous?: Post;
  next?: Post;
  own: boolean;
  named: boolean;
}) {
  const stamped = showStamp(post, previous);
  const groupedPrev = !stamped && samePerson(previous, post);
  const groupedNext =
    !!next && !showStamp(next, post) && samePerson(post, next);
  const body =
    post.message ||
    (post.status === "streaming"
      ? "…"
      : post.files.length
        ? "Attachment"
        : "");
  const caption =
    post.status === "streaming"
      ? "Writing…"
      : post.status === "draft"
        ? "Draft"
        : post.status === "published"
          ? null
          : "Not published";
  return (
    <View>
      {stamped && <Text style={chat.date}>{stampLabel(post.created_at)}</Text>}
      <View
        style={[
          chat.row,
          groupedPrev ? chat.grouped : chat.ungrouped,
          { alignItems: own ? "flex-end" : "flex-start" },
        ]}
      >
        {named && !own && !groupedPrev && (
          <Text style={chat.author}>
            {post.poster_display_name || post.agent_id || "Member"}
          </Text>
        )}
        <View style={chat.bubbleWrap}>
          <View
            style={[
              chat.bubble,
              own ? chat.outgoing : chat.incoming,
              bubbleShape(own, groupedPrev, groupedNext),
            ]}
          >
            <BubbleText text={body} own={own} />
          </View>
          {!groupedNext && <BubbleTail own={own} />}
        </View>
        {caption && <Text style={chat.author}>{caption}</Text>}
      </View>
    </View>
  );
});

function keyExtractor(post: Post) {
  return String(post.post_id);
}

const bubbleIn = DynamicColorIOS({ light: "#E9E9EB", dark: "#3A3A3C" });
const bubbleOut = "#007AFF";

const title = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 44,
    maxWidth: 240,
    paddingLeft: 8,
    paddingRight: 16,
    borderRadius: 22,
  },
  name: {
    flexShrink: 1,
    fontSize: 17,
    fontWeight: "600",
    color: color.header,
  },
});

const chat = StyleSheet.create({
  list: { flex: 1 },
  date: {
    textAlign: "center",
    color: PlatformColor("secondaryLabel"),
    fontSize: 11,
    fontWeight: "600",
    paddingTop: 12,
    paddingBottom: 8,
  },
  row: { paddingHorizontal: 10 },
  grouped: { paddingTop: 1, paddingBottom: 1 },
  ungrouped: { paddingTop: 6, paddingBottom: 6 },
  author: { fontSize: 11, color: color.muted, marginLeft: 16, marginBottom: 2 },
  bubbleWrap: { maxWidth: "75%" },
  bubble: {
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  outgoing: { backgroundColor: bubbleOut },
  incoming: { backgroundColor: bubbleIn },
  tail: {
    position: "absolute",
    bottom: 0,
    width: 11,
    height: 17,
    overflow: "hidden",
  },
  tailOut: { right: -6 },
  tailIn: { left: -6 },
  tailNub: {
    position: "absolute",
    bottom: 0,
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  tailNubOut: { left: -9 },
  tailNubIn: { right: -9 },
  tailScoop: {
    position: "absolute",
    bottom: -1,
    width: 18,
    height: 21,
    borderRadius: 10,
    backgroundColor: PlatformColor("systemBackground"),
  },
  tailScoopOut: { left: 2 },
  tailScoopIn: { right: 2 },
  message: { fontSize: 17, lineHeight: 22 },
  outgoingText: { color: "#ffffff" },
  incomingText: { color: PlatformColor("label") },
  link: { textDecorationLine: "underline" },
  sticky: { position: "absolute", bottom: 0, left: 0, right: 0 },
});

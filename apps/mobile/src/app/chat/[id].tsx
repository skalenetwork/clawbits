import {
  KeyboardAwareLegendList,
  useKeyboardChatComposerInset,
  useKeyboardScrollToEnd,
} from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewToken,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, ApiError } from "@/lib/api";
import { historyKey, useHistory, useLiveEvents } from "@/lib/data";
import {
  channelName,
  historyPosts,
  mergePost,
  type History,
  type Post,
} from "@/lib/models";
import { useSession } from "@/lib/session";
import { color, Empty, IconButton, styles } from "@/components/ui";

type Delivery = { uuid: string; text: string; state: "sending" | "uncertain" };

export default function ConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Conversation key={id} id={id} />;
}

function Conversation({ id }: { id: string }) {
  const { session } = useSession();
  const token = session!.token;
  const client = useQueryClient();
  const channel = useQuery({
    queryKey: ["channel", id],
    queryFn: ({ signal }) => api.channel(token, id, signal),
  });
  const history = useHistory(id);
  const focused = useIsFocused();
  const connected = useLiveEvents(id, focused);
  const insets = useSafeAreaInsets();
  const list = useRef<LegendListRef>(null);
  const composer = useRef<View>(null);
  const { contentInsetEndAdjustment, onComposerLayout } =
    useKeyboardChatComposerInset(list, composer, 60 + insets.bottom);
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({
    listRef: list,
  });
  const posts = historyPosts(history.data);
  const [text, setText] = useState("");
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(0);
  const read = useRef(0);
  const sending = useRef(false);
  const forbidden =
    channel.error instanceof ApiError &&
    [403, 404].includes(channel.error.status);
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<Post>[] }) => {
      const ids = viewableItems
        .filter((item) => item.isViewable && item.item.status === "published")
        .map((item) => item.item.post_id);
      setVisible(Math.max(0, ...ids));
    },
    [],
  );

  useEffect(() => {
    if (
      !focused ||
      !connected ||
      visible <= read.current ||
      AppState.currentState !== "active"
    )
      return;
    const timer = setTimeout(() => {
      void api
        .read(token, id, visible)
        .then((result) => {
          read.current = Math.max(read.current, result.last_read_post_id);
          void client.invalidateQueries({ queryKey: ["channels"] });
        })
        .catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [client, connected, focused, id, token, visible]);

  useEffect(() => {
    if (forbidden) client.removeQueries({ queryKey: historyKey(id) });
  }, [client, forbidden, id]);

  const accepted =
    !!delivery && posts.some((post) => post.client_msg_uuid === delivery.uuid);
  const pending = accepted ? null : delivery;

  const send = async () => {
    const message = text.trim();
    if (!message || sending.current || pending || !connected) return;
    sending.current = true;
    const uuid = randomUUID();
    setDelivery({ uuid, text: message, state: "sending" });
    setText("");
    setError(null);
    void scrollMessageToEnd({ animated: true, closeKeyboard: false });
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
        setText(message);
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
      <Empty
        title="Conversation unavailable"
        detail="You may no longer have access."
        onRetry={() => router.back()}
      />
    );
  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: channel.data ? channelName(channel.data) : "Conversation",
        }}
      />
      {!connected && (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.detail, { padding: 6 }]}
        >
          Connecting · Saved messages available
        </Text>
      )}
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
          data={posts}
          keyExtractor={(post) => String(post.post_id)}
          estimatedItemSize={72}
          renderItem={({ item, index }) => (
            <Message
              post={item}
              previous={posts[index - 1]}
              own={item.human_id === session!.user.id}
            />
          )}
          initialScrollAtEnd
          alignItemsAtEnd
          maintainScrollAtEnd={{ animated: false }}
          maintainScrollAtEndThreshold={0.15}
          maintainVisibleContentPosition
          contentInsetEndAdjustment={contentInsetEndAdjustment}
          freeze={freeze}
          keyboardLiftBehavior="always"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingTop: 12 }}
          onStartReached={() => {
            if (history.hasNextPage && !history.isFetching)
              void history.fetchNextPage();
          }}
          onStartReachedThreshold={1}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={{
            itemVisiblePercentThreshold: 50,
            minimumViewTime: 250,
          }}
          ListHeaderComponent={
            history.isFetchNextPageError ? (
              <Pressable
                onPress={() => {
                  void history.fetchNextPage();
                }}
                style={styles.retry}
              >
                <Text style={styles.detail}>Tap to retry older messages</Text>
              </Pressable>
            ) : null
          }
          ListFooterComponent={
            pending ? (
              <View style={chat.pending}>
                <Text style={[chat.message, chat.outgoing]}>
                  {pending.text}
                </Text>
                <Text style={styles.detail}>
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
        offset={{ closed: 0, opened: insets.bottom }}
      >
        <View
          ref={composer}
          onLayout={onComposerLayout}
          style={{
            backgroundColor: color.background,
            paddingBottom: insets.bottom + 8,
          }}
        >
          {error && !accepted && (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {error}
            </Text>
          )}
          {pending?.state === "uncertain" && (
            <Pressable
              onPress={() => {
                setText(pending.text);
                setDelivery(null);
                setError(null);
              }}
              style={styles.retry}
            >
              <Text style={styles.detail}>Keep text in composer</Text>
            </Pressable>
          )}
          <View style={chat.composer}>
            <Pressable
              disabled
              accessibilityRole="button"
              accessibilityLabel="Attachments, coming later"
              style={{ width: 36, alignItems: "center" }}
            >
              <Text style={{ fontSize: 30, color: color.muted }}>+</Text>
            </Pressable>
            <TextInput
              accessibilityLabel="Message"
              placeholder="Message"
              placeholderTextColor={color.muted}
              multiline
              maxLength={4000}
              value={text}
              onChangeText={setText}
              editable={!pending}
              style={chat.input}
            />
            <IconButton
              name="arrow.up.circle.fill"
              label="Send message"
              disabled={!connected || !text.trim() || !!pending}
              onPress={() => {
                void send();
              }}
            />
          </View>
        </View>
      </KeyboardStickyView>
    </View>
  );
}

function Message({
  post,
  previous,
  own,
}: {
  post: Post;
  previous?: Post;
  own: boolean;
}) {
  const showDate =
    !previous ||
    new Date(previous.created_at).toDateString() !==
      new Date(post.created_at).toDateString();
  const showAuthor =
    showDate ||
    previous?.human_id !== post.human_id ||
    previous?.agent_id !== post.agent_id;
  return (
    <>
      {showDate && (
        <Text style={chat.date}>
          {new Date(post.created_at).toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </Text>
      )}
      <View style={[chat.row, { alignItems: own ? "flex-end" : "flex-start" }]}>
        {!own && showAuthor && (
          <Text style={chat.author}>
            {post.poster_display_name || post.agent_id || "Member"}
            {post.agent_id ? " · Agent" : ""}
          </Text>
        )}
        <View style={[chat.bubble, own ? chat.outgoing : chat.incoming]}>
          <Text
            selectable
            style={[chat.message, { color: own ? "white" : color.text }]}
          >
            {post.message || (post.status === "streaming" ? "…" : "Attachment")}
          </Text>
          {post.files.length > 0 && (
            <Text style={{ color: own ? "white" : color.muted, fontSize: 13 }}>
              {post.files.length} attachment{post.files.length === 1 ? "" : "s"}{" "}
              · View on web
            </Text>
          )}
        </View>
        {post.status !== "published" && (
          <Text style={chat.author}>
            {post.status === "streaming"
              ? "Writing…"
              : post.status === "draft"
                ? "Draft"
                : "Not published"}
          </Text>
        )}
      </View>
    </>
  );
}

const chat = StyleSheet.create({
  date: {
    textAlign: "center",
    color: color.muted,
    fontSize: 12,
    fontWeight: "600",
    paddingVertical: 16,
  },
  row: { paddingHorizontal: 16, paddingVertical: 4, gap: 3 },
  author: { fontSize: 12, color: color.muted, marginHorizontal: 12 },
  bubble: {
    maxWidth: "86%",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 6,
  },
  outgoing: { backgroundColor: color.blue, color: "white", borderRadius: 20 },
  incoming: { backgroundColor: color.secondary },
  message: { fontSize: 17, lineHeight: 23 },
  pending: { alignItems: "flex-end", padding: 16, gap: 6 },
  sticky: { position: "absolute", bottom: 0, left: 0, right: 0 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 8,
    paddingTop: 8,
    gap: 4,
  },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 17,
    color: color.text,
    minHeight: 44,
    maxHeight: 150,
  },
});

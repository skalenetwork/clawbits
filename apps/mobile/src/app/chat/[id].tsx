import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { randomUUID } from "expo-crypto";
import { Image } from "expo-image";
import * as WebBrowser from "expo-web-browser";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActionSheetIOS,
  Alert,
  AppState,
  Keyboard,
  Linking,
  Modal,
  PlatformColor,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { GlassView } from "expo-glass-effect";
import { SymbolView } from "expo-symbols";
import Svg, { Path } from "react-native-svg";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, ApiError, mcpConnectLinkId } from "@/lib/api";
import { BUBBLE_TAIL, bubblePath } from "@/lib/bubblePath";
import { deleteChannelFile, uploadChannelFile, type LocalFile } from "@/lib/upload";
import { historyKey, useHistory, useLiveEvents } from "@/lib/data";
import { useLiveTurn, useLiveTurns, type LiveTurn } from "@/lib/liveTurn";
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
  type ComposerAttachment,
  type GlassComposerHandle,
} from "@/components/ui";
import { McpConnectCard } from "@/components/mcp-connect-card";
import { TurnTrace } from "@/components/turn-trace";

type Delivery = { uuid: string; text: string; state: "sending" | "uncertain" };

type PendingFile = ComposerAttachment & { fileId?: string };

function itemsAreEqual(prev: Post, next: Post) {
  return (
    prev.post_id === next.post_id &&
    prev.message === next.message &&
    prev.status === next.status &&
    prev.updated_at === next.updated_at &&
    prev.files.length === next.files.length &&
    prev.files.every((file, index) => file.file_id === next.files[index]?.file_id)
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
  const [composerHeight, setComposerHeight] = useState(0);
  const listPad = useMemo(
    () => ({ paddingTop: insets.top + 44, paddingBottom: composerHeight }),
    [composerHeight, insets.top],
  );
  const list = useRef<LegendListRef>(null);
  const field = useRef<GlassComposerHandle>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const pinToEnd = () => {
      void list.current?.scrollToEnd({ animated: false });
    };
    const show = Keyboard.addListener("keyboardWillShow", () => {
      setKeyboardOpen(true);
      pinToEnd();
      requestAnimationFrame(pinToEnd);
    });
    const hide = Keyboard.addListener("keyboardWillHide", () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const posts = useMemo(() => historyPosts(history.data), [history.data]);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const read = useRef(0);
  const sending = useRef(false);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedRef = useRef(focused);
  const connectedRef = useRef(connected);
  useEffect(() => {
    focusedRef.current = focused;
    connectedRef.current = connected;
  }, [focused, connected]);
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

  const uploading = files.some((file) => file.status === "uploading");
  const readyFiles = files.filter((file) => file.status === "uploaded" && file.fileId);
  const addFile = (local: LocalFile) => {
    const localId = randomUUID();
    let room = true;
    setFiles((current) => {
      if (current.length >= 5) {
        room = false;
        return current;
      }
      return [...current, { id: localId, name: local.name, status: "uploading" }];
    });
    if (!room) {
      Alert.alert("Too many files", "A message can include up to 5 files.");
      return;
    }
    void uploadChannelFile(token, id, local)
      .then((fileId) => {
        setFiles((current) =>
          current.map((file) =>
            file.id === localId ? { ...file, status: "uploaded", fileId } : file,
          ),
        );
      })
      .catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message : "Upload failed.";
        setFiles((current) =>
          current.map((file) =>
            file.id === localId ? { ...file, status: "failed" } : file,
          ),
        );
        Alert.alert("Could not attach", detail);
      });
  };
  const pick = (source: "library" | "camera" | "file") => {
    void (async () => {
      if (source === "file") {
        const chosen = await DocumentPicker.getDocumentAsync({
          multiple: true,
          copyToCacheDirectory: true,
        });
        if (chosen.canceled) return;
        for (const asset of chosen.assets)
          addFile({
            uri: asset.uri,
            name: asset.name,
            type: asset.mimeType || "application/octet-stream",
            size: asset.size,
          });
        return;
      }
      const permission =
        source === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Permission needed",
          source === "camera"
            ? "Allow camera access to take a photo."
            : "Allow photo access to attach a picture.",
        );
        return;
      }
      const chosen =
        source === "camera"
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85 })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images"],
              quality: 0.85,
              allowsMultipleSelection: true,
              selectionLimit: 5,
            });
      if (chosen.canceled) return;
      for (const asset of chosen.assets)
        addFile({
          uri: asset.uri,
          name: asset.fileName || "photo.jpg",
          type: asset.mimeType || "image/jpeg",
          size: asset.fileSize,
          width: asset.width,
          height: asset.height,
        });
    })().catch((cause: unknown) => {
      Alert.alert(
        "Could not attach",
        cause instanceof Error ? cause.message : "Please try again.",
      );
    });
  };
  const openAttachments = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Photo Library", "Take Photo", "Choose File", "Cancel"],
        cancelButtonIndex: 3,
      },
      (index) => {
        if (index === 0) pick("library");
        else if (index === 1) pick("camera");
        else if (index === 2) pick("file");
      },
    );
  };
  const removeFile = (localId: string) => {
    const file = files.find((item) => item.id === localId);
    setFiles((current) => current.filter((item) => item.id !== localId));
    if (file?.fileId) void deleteChannelFile(token, file.fileId);
  };
  const send = async (message: string) => {
    const fileIds = readyFiles.flatMap((file) => (file.fileId ? [file.fileId] : []));
    if ((!message && fileIds.length === 0) || sending.current || pending || !connected || uploading)
      return;
    sending.current = true;
    const uuid = randomUUID();
    setDelivery({ uuid, text: message, state: "sending" });
    setFiles([]);
    setError(null);
    try {
      const post = await api.send(token, id, message, uuid, fileIds);
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
        setFiles(readyFiles);
        void field.current?.setText(message);
        setError(cause.message);
      } else {
        setFiles(readyFiles);
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
        <KeyboardAvoidingView
          behavior="padding"
          automaticOffset
          style={chat.list}
        >
        <View style={chat.list}>
        <LegendList
          ref={list}
          style={StyleSheet.absoluteFill}
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
            on: { dataChange: true, footerLayout: true, layout: true, itemLayout: false },
          }}
          maintainVisibleContentPosition={{ data: true, size: true }}
          contentInsetAdjustmentBehavior="never"
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
            <>
              {pending && (
                <View
                  style={[chat.row, chat.ungrouped, { alignItems: "flex-end" }]}
                >
                  <Bubble own groupedPrev={false} groupedNext={false}>
                    <Text style={[chat.message, chat.outgoingText]}>
                      {pending.text}
                    </Text>
                  </Bubble>
                  <Text style={chat.author}>
                    {pending.state === "sending"
                      ? "Sending…"
                      : "Delivery unconfirmed"}
                  </Text>
                </View>
              )}
              <Generating channel={id} posts={posts} named={named} />
            </>
          }
        />
        <View pointerEvents="box-none" style={chat.composerDock}>
        <View
          onLayout={(event) => {
            const height = Math.round(event.nativeEvent.layout.height);
            setComposerHeight((current) => (current === height ? current : height));
          }}
          style={[
            chat.composer,
            { paddingBottom: keyboardOpen ? 8 : insets.bottom + 8 },
          ]}
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
            placeholder={title ? `Message ${title.split(" ")[0]}` : "Message"}
            attachments={files}
            onPlus={openAttachments}
            onRemoveAttachment={removeFile}
            onSend={(message) => {
              void send(message);
            }}
            sendDisabled={!connected || !!pending || uploading}
          />
        </View>
        </View>
        </View>
        </KeyboardAvoidingView>
      )}
      <Stack.Screen options={header} />
    </>
  );
}

/** Agents generating with no draft yet: each one's turn line alone, where its reply will land. */
function Generating({ channel, posts, named }: { channel: string; posts: Post[]; named: boolean }) {
  const turns = useLiveTurns(channel);
  return Object.entries(turns).map(([agent, turn]) =>
    posts.some((post) => post.agent_id === agent && post.status === "streaming") ? null : (
      <Upcoming key={agent} agent={agent} turn={turn} posts={posts} named={named} />
    ),
  );
}

/** An agent's turn line before its draft exists, framed as the reply it stands in for, so the draft's own line takes
 *  over at the same place. */
function Upcoming({ agent, turn, posts, named }: { agent: string; turn: LiveTurn; posts: Post[]; named: boolean }) {
  const [created_at] = useState(() => new Date().toISOString());
  const name = posts.findLast((post) => post.agent_id === agent)?.poster_display_name ?? null;
  return (
    <Row
      post={{ human_id: null, agent_id: agent, poster_display_name: name, created_at }}
      previous={posts.at(-1)}
      own={false}
      named={named}
    >
      <TurnTrace turn={turn} />
    </Row>
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

function Bubble({
  own,
  groupedPrev,
  groupedNext,
  card = false,
  children,
}: {
  own: boolean;
  groupedPrev: boolean;
  groupedNext: boolean;
  card?: boolean;
  children: ReactNode;
}) {
  const scheme = useColorScheme();
  const [box, setBox] = useState({ w: 0, h: 0 });
  const fill = own ? "#007AFF" : scheme === "dark" ? "#3A3A3C" : "#E9E9EB";
  const tail = groupedNext ? 0 : BUBBLE_TAIL;
  return (
    <View style={card ? chat.cardWrap : chat.bubbleWrap}>
      <View
        onLayout={(event) => {
          const w = Math.round(event.nativeEvent.layout.width);
          const h = Math.round(event.nativeEvent.layout.height);
          setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
        }}
        style={[chat.bubble, card && chat.cardBubble]}
      >
        {box.w > 0 && box.h > 0 ? (
          <Svg
            width={box.w + tail}
            height={box.h}
            pointerEvents="none"
            style={[chat.bubbleSvg, own ? null : { left: -tail }]}
          >
            <Path
              d={bubblePath(box.w, box.h, own, groupedPrev, groupedNext)}
              fill={fill}
            />
          </Svg>
        ) : null}
        {children}
      </View>
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
  const parts = text.split(/(https?:\/\/[^\s()<>`*]*[^\s()<>`*.,;:!?'"])/g);
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

function isImageFile(file: Post["files"][number]) {
  return (
    file.content_type?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|heic)$/i.test(file.filename)
  );
}

function MessageFiles({ files, own }: { files: Post["files"]; own: boolean }) {
  const { session } = useSession();
  const insets = useSafeAreaInsets();
  const [photo, setPhoto] = useState<string | null>(null);
  if (!files.length) return null;
  const openFile = (file: Post["files"][number]) => {
    const token = session?.token;
    if (!token) return;
    void api
      .fileUrl(token, file.file_id)
      .then(({ url }) => WebBrowser.openBrowserAsync(url))
      .catch(() => {
        Alert.alert("Could not open", file.filename);
      });
  };
  const openPhoto = (file: Post["files"][number]) => {
    if (file.download_url) {
      setPhoto(file.download_url);
      return;
    }
    const token = session?.token;
    if (!token) return;
    void api
      .fileUrl(token, file.file_id)
      .then(({ url }) => setPhoto(url))
      .catch(() => {
        Alert.alert("Could not open", file.filename);
      });
  };
  return (
    <View>
      {files.map((file) =>
        isImageFile(file) ? (
          <Pressable
            key={file.file_id}
            accessibilityLabel={file.filename}
            onPress={() => openPhoto(file)}
          >
            <Image
              source={file.download_url ?? undefined}
              contentFit="cover"
              style={{
                width: 220,
                height:
                  file.width && file.height
                    ? Math.round(Math.min(280, 220 * (file.height / file.width)))
                    : 160,
                borderRadius: 14,
                marginTop: 6,
                backgroundColor: "rgba(127,127,127,0.25)",
              }}
            />
          </Pressable>
        ) : (
          <Text
            key={file.file_id}
            onPress={() => openFile(file)}
            style={[
              chat.message,
              own ? chat.outgoingText : chat.incomingText,
              chat.fileLink,
            ]}
          >
            {file.filename}
          </Text>
        ),
      )}
      <Modal
        animationType="fade"
        visible={photo !== null}
        onRequestClose={() => setPhoto(null)}
      >
        <Pressable
          accessibilityLabel="Close photo"
          onPress={() => setPhoto(null)}
          style={chat.viewer}
        >
          {photo ? (
            <Image source={photo} contentFit="contain" style={chat.viewerPhoto} />
          ) : null}
          <View style={[chat.viewerClose, { top: insets.top + 8 }]}>
            <SymbolView name="xmark" size={16} weight="bold" tintColor="#ffffff" />
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

/** Who wrote a row and when: a post, or the stand-in for a reply whose draft does not exist yet. */
type Author = Pick<Post, "human_id" | "agent_id" | "poster_display_name" | "created_at">;

/** Whether a row continues the one before it: the same author, with no date stamp between. */
function continues(post: Author, previous?: Author): boolean {
  return !showStamp(post, previous) && samePerson(previous, post);
}

/** A row's frame: its date stamp, its author in named channels, and the padding that groups it with the row
 *  before. */
function Row({
  post,
  previous,
  own,
  named,
  children,
}: {
  post: Author;
  previous?: Post;
  own: boolean;
  named: boolean;
  children: ReactNode;
}) {
  const grouped = continues(post, previous);
  return (
    <View>
      {showStamp(post, previous) && <Text style={chat.date}>{stampLabel(post.created_at)}</Text>}
      <View
        style={[
          chat.row,
          grouped ? chat.grouped : chat.ungrouped,
          { alignItems: own ? "flex-end" : "flex-start" },
        ]}
      >
        {named && !own && !grouped && (
          <Text style={chat.author}>
            {post.poster_display_name || post.agent_id || "Member"}
          </Text>
        )}
        {children}
      </View>
    </View>
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
  const streaming = post.status === "streaming";
  const turn = useLiveTurn(post.channel_id, streaming ? post.agent_id : null);
  const groupedPrev = continues(post, previous);
  const groupedNext = !!next && continues(next, post);
  const body = post.message;
  const linkId = own ? undefined : mcpConnectLinkId(body.trim());
  const caption =
    post.status === "draft"
      ? "Draft"
      : post.status === "rejected"
        ? "Not published"
        : null;
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = () => {
    if (!body) return;
    void Clipboard.setStringAsync(body).then(() => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1200);
    });
  };
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );
  return (
    <Row post={post} previous={previous} own={own} named={named}>
      {post.agent_id && (streaming || post.status === "published") ? (
        <TurnTrace post={post} turn={turn} />
      ) : null}
      {streaming && !body && post.files.length === 0 ? null : (
        <Pressable
          accessibilityHint={body ? "Copies the message" : undefined}
          delayLongPress={350}
          onLongPress={body ? copy : undefined}
        >
        <Bubble
          own={own}
          groupedPrev={groupedPrev}
          groupedNext={groupedNext}
          card={!!linkId}
        >
          {linkId ? (
            <McpConnectCard linkId={linkId} />
          ) : (
            <>
              {body ? <BubbleText text={body} own={own} /> : null}
              <MessageFiles files={post.files} own={own} />
            </>
          )}
        </Bubble>
        </Pressable>
      )}
      {(copied || caption) && (
        <Text style={chat.author}>{copied ? "Copied" : caption}</Text>
      )}
    </Row>
  );
});

function keyExtractor(post: Post) {
  return String(post.post_id);
}

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
  composerDock: { flex: 1, justifyContent: "flex-end" },
  composer: { paddingTop: 8, backgroundColor: "transparent" },
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
  cardWrap: { width: "88%" },
  bubble: {
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  bubbleSvg: { position: "absolute", top: 0, left: 0 },
  cardBubble: { paddingVertical: 12 },
  message: { fontSize: 17, lineHeight: 22 },
  outgoingText: { color: "#ffffff" },
  incomingText: { color: PlatformColor("label") },
  link: { textDecorationLine: "underline" },
  fileLink: { marginTop: 4, textDecorationLine: "underline" },
  viewer: { flex: 1, backgroundColor: "#000000" },
  viewerPhoto: { flex: 1 },
  viewerClose: {
    position: "absolute",
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.22)",
  },
});

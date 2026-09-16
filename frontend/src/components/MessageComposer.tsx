import {
  use,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { ArrowDown, ArrowUp, Plus, Reply, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { MENU_SURFACE } from "@/lib/menuSurface";

import { AgentTargetChip } from "@/components/composer/AgentTargetChip";
import {
  AdminCommandPopover,
  ChannelPopover,
  EmojiShortcodePopover,
  MentionPopover,
  type ChannelItem,
  type MentionItem,
} from "@/components/composer/popovers";
import { AttachmentChip } from "@/components/AttachmentChip";
import { MENTION_TOKEN_RE, MentionsContext, type MessageMentions } from "@/components/mentionsContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { extractAdminCommandQuery, getAdminCommandOptions } from "@/lib/adminCommands";
import { extractClipboardFiles } from "@/lib/clipboardFiles";
import { extractShortcodeQuery } from "@/lib/emoji";
import { modGlyph } from "@/lib/shortcuts/platform";
import { HERE_TOKEN, escapeRegExp, isHereToken } from "@/lib/mentions";
import { draftStore } from "@/lib/messageDrafts";
import {
  extractChannelQuery,
  extractMentionQuery,
  mentionHandle,
  mentionLabel,
  posterName,
  quotedBodyText,
} from "@/lib/messageHelpers";
import type { MmChannelMember, MmChannelPost, MmChannelType } from "@/lib/api";
import type { PendingAutoMention } from "@/lib/autoMention";
import type { PendingAttachment } from "@/hooks/useChannelAttachments";

const MAX_LEN = 4000;
const COUNTER_THRESHOLD = 3500;
const SUGGESTION_LIMIT = 8;

const SURFACE =
  "border border-border/60 bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 dark:bg-card/95 dark:supports-[backdrop-filter]:bg-card/85";

const SHORTCUTS = [
  { keys: ["↵"], label: "Send message" },
  { keys: ["⇧", "↵"], label: "New line" },
  { keys: [modGlyph, "B"], label: "Bold" },
  { keys: [modGlyph, "I"], label: "Italic" },
  { keys: [modGlyph, "J"], label: "Target agent" },
  { keys: [modGlyph, "⇧", "J"], label: "Cycle agent" },
  { keys: ["/"], label: "Agent commands" },
  { keys: ["@"], label: "Mention someone" },
  { keys: [":"], label: "Emoji shortcode" },
  { keys: ["Esc"], label: "Close · cancel reply · clear target" },
  { keys: [modGlyph, "/"], label: "This cheatsheet" },
];

export interface ComposerHandle {
  focus: () => void;
  insert: (text: string) => void;
}

export interface TypingPerson {
  key: string;
  displayName: string;
  status: "typing" | "generating";
}

interface MessageComposerProps {
  ref: Ref<ComposerHandle>;
  isMobile: boolean;
  wrapperRef: RefObject<HTMLDivElement | null>;
  channelId: string;
  userId: number | null;
  channelType: MmChannelType | undefined;
  members: MmChannelMember[];
  replyingTo: MmChannelPost | null;
  onCancelReply: () => void;
  autoMention: PendingAutoMention | null;
  onDismissAutoMention: () => void;
  manualTargetHandle: string | null;
  onSetManualTarget: (handle: string | null) => void;
  attachments: PendingAttachment[];
  onAttachmentsAdd: (files: File[] | FileList) => void;
  onAttachmentRemove: (localId: string) => void;
  isUploading: boolean;
  isReadyToSend: boolean;
  uploadedFileIdsCount: number;
  onSubmit: (text: string) => Promise<unknown>;
  onEditLast: () => void;
  isSending: boolean;
  isChatAtBottom: boolean;
  onScrollChatToBottom: () => void;
  activityPeople: readonly TypingPerson[];
  agentDm: boolean;
  onTyping: () => void;
  placeholder?: string;
}

function ComposerHighlightedText({ text, mentions }: { text: string; mentions: MessageMentions | null }) {
  return text.split(MENTION_TOKEN_RE).map((part, i) => {
    if (i % 2 === 0) return part;
    const token = part.slice(1).toLowerCase();
    const resolved = part.startsWith("#")
      ? mentions?.channelsByToken.has(token)
      : isHereToken(token) || mentions?.memberByToken.has(token);
    return (
      <span key={i} className={resolved ? "text-mention" : "text-muted-foreground/90"}>
        {part}
      </span>
    );
  });
}

function ShortcutsCheatsheet({
  open,
  onOpenChange,
  anchor,
  agentShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: RefObject<HTMLElement | null>;
  agentShortcuts: boolean;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={anchor} align="end" side="top" sideOffset={8} className="isolate z-50">
          <PopoverPrimitive.Popup className={cn(MENU_SURFACE, "z-50 w-72 origin-(--transform-origin) overflow-hidden data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95")}>
            {SHORTCUTS.filter((row) => agentShortcuts || !row.keys.includes("J")).map((row) => (
              <div key={row.label} className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-[13px] leading-5">
                <span className="truncate">{row.label}</span>
                <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                  {row.keys.map((k, i) => (
                    <kbd key={i} className="font-sans">{k}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function TypingRow({ people }: { people: readonly TypingPerson[] }) {
  const [first] = people;
  if (!first) return <div aria-hidden className="h-4"/>;
  const names = people.length > 2
    ? `${first.displayName} and ${people.length - 1} others`
    : people.map((p) => p.displayName).join(" and ");
  const label = `${names} ${people.length > 1 ? "are" : "is"} ${people.every((p) => p.status === "generating") ? "thinking" : "typing"}`;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className="animate-typing-row-in flex h-4 min-w-0 items-center gap-1.5 px-3.5 text-[11px] text-muted-foreground"
    >
      <span className="inline-flex shrink-0 items-center gap-[2px]" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className="typing-dot block size-[3.5px] rounded-full bg-muted-foreground"/>
        ))}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

function mentionOptionsFor(
  members: readonly MmChannelMember[],
  query: string,
  channelType: MmChannelType | undefined,
): MentionItem[] {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const items: MentionItem[] = channelType !== "direct" && HERE_TOKEN.startsWith(q) ? [{ label: "here", handle: HERE_TOKEN }] : [];
  for (const member of members) {
    if (items.length === SUGGESTION_LIMIT) break;
    if (member.agent_id && member.can_tag === false) continue;
    const handle = mentionHandle(member);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    const label = mentionLabel(member);
    if (!q || handle.toLowerCase().includes(q) || label.toLowerCase().includes(q)) items.push({ label, handle, member });
  }
  return items;
}

function channelOptionsFor(mentions: MessageMentions | null, query: string): ChannelItem[] {
  if (!mentions) return [];
  const q = query.toLowerCase();
  const options: ChannelItem[] = [];
  for (const [token, channel] of mentions.channelsByToken) {
    if (options.length === SUGGESTION_LIMIT) break;
    if (q && !token.includes(q) && !(channel.display_name ?? channel.name).toLowerCase().includes(q)) continue;
    options.push({ token, channel, isMember: mentions.currentUserChannelIds.has(channel.channel_id) });
  }
  return options;
}

const loadEmojiSearch = () => import("node-emoji").then(({ search }) => search);

export function MessageComposer({
  ref,
  isMobile,
  wrapperRef,
  channelId,
  userId,
  channelType,
  members,
  replyingTo,
  onCancelReply,
  autoMention,
  onDismissAutoMention,
  manualTargetHandle,
  onSetManualTarget,
  attachments,
  onAttachmentsAdd,
  onAttachmentRemove,
  isUploading,
  isReadyToSend,
  uploadedFileIdsCount,
  onSubmit,
  onEditLast,
  isSending,
  isChatAtBottom,
  onScrollChatToBottom,
  activityPeople,
  agentDm,
  onTyping,
  placeholder,
}: MessageComposerProps) {
  const mentions = use(MentionsContext);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(() =>
    userId == null ? "" : (draftStore.get(userId, channelId)?.text ?? ""),
  );
  const [caretPos, setCaretPos] = useState(draft.length);
  const [cursor, setCursor] = useState({ key: "", index: 0, dismissed: false });
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const [emojiSearch, setEmojiSearch] = useState<typeof import("node-emoji").search | null>(null);

  const adminMatch = agentDm ? extractAdminCommandQuery(draft, caretPos) : null;
  const mentionMatch = extractMentionQuery(draft, caretPos);
  const channelMatch = extractChannelQuery(draft, caretPos);
  const emojiMatch = extractShortcodeQuery(draft, caretPos);
  const wantsEmoji = emojiMatch != null;

  useEffect(() => {
    if (wantsEmoji && !emojiSearch) void loadEmojiSearch().then((search) => { setEmojiSearch(() => search); });
  }, [wantsEmoji, emojiSearch]);

  const adminOptions = adminMatch ? getAdminCommandOptions(adminMatch.query) : [];
  const mentionOptions = mentionMatch ? mentionOptionsFor(members, mentionMatch.query, channelType) : [];
  const channelOptions = channelMatch ? channelOptionsFor(mentions, channelMatch.query) : [];
  const emojiOptions = emojiSearch && emojiMatch ? emojiSearch(new RegExp(escapeRegExp(emojiMatch.query))).slice(0, SUGGESTION_LIMIT) : [];

  const suggestion = [
    { kind: "admin", match: adminMatch, extract: extractAdminCommandQuery, texts: adminOptions.map((o) => `${o.command} `) },
    { kind: "mention", match: mentionMatch, extract: extractMentionQuery, texts: mentionOptions.map((o) => `@${o.handle} `) },
    { kind: "channel", match: channelMatch, extract: extractChannelQuery, texts: channelOptions.map((o) => `#${o.token} `) },
    { kind: "emoji", match: emojiMatch, extract: extractShortcodeQuery, texts: emojiOptions.map((o) => o.emoji) },
  ].find((s) => s.match && s.texts.length > 0);
  const popoverKey = suggestion?.match ? `${suggestion.kind}:${suggestion.match.start}:${suggestion.match.query}` : "";
  const popover = suggestion && !(cursor.key === popoverKey && cursor.dismissed) ? suggestion : undefined;
  const activeIndex = popover && cursor.key === popoverKey ? Math.min(cursor.index, popover.texts.length - 1) : 0;

  const caretNow = () => inputRef.current?.selectionStart ?? caretPos;

  const replaceRange = (start: number, end: number, text: string) => {
    const caret = start + text.length;
    setDraft(draft.slice(0, start) + text + draft.slice(end));
    setCaretPos(caret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    });
  };

  const complete = (index: number) => {
    const text = popover?.texts[index];
    const match = popover?.extract(draft, caretNow());
    if (text !== undefined && match) replaceRange(match.start, match.end, text);
  };

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
    },
    insert: (text: string) => {
      const start = caretNow();
      replaceRange(start, inputRef.current?.selectionEnd ?? start, text);
    },
  }));

  const wrapSelection = (marker: string, placeholderText: string) => {
    const { selectionStart: start, selectionEnd: end } = inputRef.current!;
    const selected = start !== end ? draft.slice(start, end) : placeholderText;
    setDraft(draft.slice(0, start) + marker + selected + marker + draft.slice(end));
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + marker.length, start + marker.length + selected.length);
      setCaretPos(start + marker.length + selected.length);
    });
  };

  const refocusInput = () => {
    requestAnimationFrame(() => { inputRef.current?.focus(); });
  };

  const agents = members.filter(
    (m): m is MmChannelMember & { agent_id: string } => m.agent_id != null && m.can_tag !== false,
  );
  const targetHandle = manualTargetHandle ?? autoMention?.handle ?? null;
  const agentPicker = !agentDm && agents.length > 0;

  const canSend = isReadyToSend && (draft.trim() !== "" || (attachments.length > 0 && uploadedFileIdsCount > 0));
  const busy = isSending || isUploading;

  const submit = () => {
    if (!canSend || isSending) return;
    const text = draft;
    setDraft("");
    setCaretPos(0);
    inputRef.current?.focus();
    onSubmit(text).catch(() => {
      setDraft((current) => current || text);
    });
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const composing = e.nativeEvent.isComposing;
    if (popover) {
      const count = popover.texts.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor({ key: popoverKey, index: (activeIndex + (e.key === "ArrowDown" ? 1 : count - 1)) % count, dismissed: false });
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !composing) {
        e.preventDefault();
        complete(activeIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCursor({ key: popoverKey, index: activeIndex, dismissed: true });
        return;
      }
    }

    if (e.key === "ArrowUp" && draft === "" && !e.shiftKey && !mod && !e.altKey && !composing) {
      e.preventDefault();
      onEditLast();
      return;
    }

    if (mod && e.key === "/") {
      e.preventDefault();
      setCheatsheetOpen((v) => !v);
      return;
    }

    if (mod && !e.shiftKey && !e.altKey && (key === "b" || key === "i")) {
      e.preventDefault();
      if (key === "b") wrapSelection("**", "bold text");
      else wrapSelection("*", "italic text");
      return;
    }

    if (mod && key === "j") {
      e.preventDefault();
      if (!agentPicker) return;
      if (e.shiftKey) {
        const next = agents[(agents.findIndex((a) => a.agent_id === targetHandle) + 1) % agents.length];
        if (next) onSetManualTarget(next.agent_id);
      } else {
        setPickerOpen((v) => !v);
      }
      return;
    }

    if (e.key === "Escape" && (cheatsheetOpen || replyingTo || targetHandle)) {
      e.preventDefault();
      if (cheatsheetOpen) setCheatsheetOpen(false);
      else if (replyingTo) onCancelReply();
      else if (manualTargetHandle) onSetManualTarget(null);
      else onDismissAutoMention();
      return;
    }

    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      submit();
    }
  };

  useEffect(() => {
    if (userId != null) draftStore.set(userId, channelId, { text: draft, reply: replyingTo, targetAgentId: manualTargetHandle });
  }, [userId, channelId, draft, replyingTo, manualTargetHandle]);

  useEffect(() => {
    const input = inputRef.current!;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return () => { draftStore.flush(); };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const input = inputRef.current;
      if (
        ["TEXTAREA", "INPUT", "SELECT"].includes(target.tagName) ||
        target.isContentEditable ||
        e.metaKey || e.ctrlKey || e.altKey ||
        (e.key.length !== 1 && e.key !== "Dead") ||
        e.isComposing ||
        window.getSelection()?.toString() ||
        document.querySelector('[role="dialog"][data-state="open"]') ||
        window.matchMedia("(pointer: coarse)").matches ||
        !input ||
        document.activeElement === input
      ) return;
      // No preventDefault: the keystroke lands in the now-focused textarea.
      input.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, []);

  if (wrapped && draft === "") setWrapped(false);
  const stacked = wrapped || draft.includes("\n") || replyingTo != null || attachments.length > 0;

  useEffect(() => {
    const el = sizerRef.current!;
    const line = parseFloat(getComputedStyle(el).lineHeight);
    const ro = new ResizeObserver(() => {
      if (el.offsetHeight > line * 1.5) flushSync(() => { setWrapped(true); });
    });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);

  const remaining = MAX_LEN - draft.length;

  return (
    <div
      ref={wrapperRef}
      data-glass={isMobile ? "" : undefined}
      // Absolute, never fixed: the mobile shell shrinks with the keyboard and lifts the composer with it.
      className={
        isMobile
          ? "pointer-events-none absolute inset-x-0 bottom-0 z-10 px-2 pb-[max(0.5rem,var(--safe-bottom))]"
          : "pointer-events-none absolute inset-x-0 bottom-2.5 z-10 px-3 pb-[var(--safe-bottom)] max-md:px-2"
      }
    >
      {/* The padding mirrors a message row's mx-0.5 pl-2.5 pr-3, so the pill lines up with message text. */}
      <div className="pointer-events-auto relative mx-auto max-w-chat pr-3.5 pl-3">
        {!isChatAtBottom && (
          <button
            type="button"
            onClick={onScrollChatToBottom}
            aria-label="Jump to latest"
            className={cn(
              SURFACE,
              "absolute bottom-full left-1/2 mb-1.5 flex size-8 -translate-x-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors animate-in fade-in slide-in-from-bottom-1 duration-200 hover:text-foreground",
            )}
          >
            <ArrowDown className="size-4"/>
          </button>
        )}
        {popover?.kind === "admin" && (
          <AdminCommandPopover options={adminOptions} activeIndex={activeIndex} query={adminMatch?.query ?? ""} onSelect={complete}/>
        )}
        {popover?.kind === "mention" && (
          <MentionPopover options={mentionOptions} activeIndex={activeIndex} onSelect={complete}/>
        )}
        {popover?.kind === "channel" && (
          <ChannelPopover options={channelOptions} activeIndex={activeIndex} onSelect={complete}/>
        )}
        {popover?.kind === "emoji" && (
          <EmojiShortcodePopover options={emojiOptions} activeIndex={activeIndex} onSelect={complete}/>
        )}
        <TypingRow people={activityPeople}/>
        <form
          data-stacked={stacked ? "" : undefined}
          className={cn(
            SURFACE,
            "group/composer flex flex-wrap items-center gap-1.5 rounded-[22px] p-[7px] transition-colors focus-within:border-border/80 data-stacked:rounded-[18px]",
          )}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {replyingTo && (
            <div className="order-first flex min-w-0 basis-full items-center gap-2 pt-0.5 pl-[7px] text-xs text-muted-foreground">
              <Reply className="size-3.5 shrink-0"/>
              <span className="min-w-0 flex-1 truncate">
                Replying to <span className="font-medium text-foreground">{posterName(replyingTo)}</span>
                {" · "}
                {quotedBodyText(replyingTo.message || "", replyingTo.files?.length ?? 0)}
              </span>
              <button
                type="button"
                onClick={onCancelReply}
                aria-label="Cancel reply"
                className="grid size-5 shrink-0 place-items-center rounded-md transition-colors hover:bg-foreground/6 hover:text-foreground"
              >
                <X className="size-3"/>
              </button>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="order-first flex basis-full flex-wrap gap-1.5">
              {attachments.map((a) => (
                <AttachmentChip key={a.localId} attachment={a} onRemove={onAttachmentRemove}/>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (!e.target.files?.length) return;
              onAttachmentsAdd(e.target.files);
              e.target.value = "";
              refocusInput();
            }}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Add attachment"
                  className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground/6 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                >
                  <Plus className="size-4"/>
                </button>
              }
            />
            <TooltipContent side="top" sideOffset={6} className="text-xs">Attach files</TooltipContent>
          </Tooltip>
          <div className="grid min-w-0 flex-1 px-1 group-data-stacked/composer:order-first group-data-stacked/composer:basis-full group-data-stacked/composer:px-[7px] group-data-stacked/composer:pt-1 group-data-stacked/composer:pb-0.5">
            <div
              ref={sizerRef}
              aria-hidden="true"
              data-composer-sizer=""
              className="pointer-events-none [grid-area:1/1] min-h-5 max-h-[40vh] overflow-hidden whitespace-pre-wrap break-words text-[14px] leading-5 text-foreground"
            >
              <ComposerHighlightedText text={draft} mentions={mentions}/>{" "}
            </div>
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setCaretPos(e.target.selectionStart);
                if (e.target.value) onTyping();
              }}
              onClick={(e) => { setCaretPos(e.currentTarget.selectionStart); }}
              onKeyUp={(e) => { setCaretPos(e.currentTarget.selectionStart); }}
              onSelect={(e) => { setCaretPos(e.currentTarget.selectionStart); }}
              onKeyDown={handleKeyDown}
              onScroll={(e) => { sizerRef.current!.scrollTop = e.currentTarget.scrollTop; }}
              onPaste={(e) => {
                const files = extractClipboardFiles(e.nativeEvent);
                if (files.length > 0) {
                  e.preventDefault();
                  onAttachmentsAdd(files);
                }
              }}
              placeholder={placeholder ?? "Write a message…"}
              maxLength={MAX_LEN}
              spellCheck
              className="[grid-area:1/1] block w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-[14px] leading-5 text-transparent caret-foreground outline-none shadow-none placeholder:text-muted-foreground focus-visible:ring-0 selection:bg-primary/20 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            />
          </div>
          {agentPicker && (
            <AgentTargetChip
              agents={agents}
              targetHandle={targetHandle}
              open={pickerOpen}
              onOpenChange={(open, refocus) => {
                setPickerOpen(open);
                if (refocus) refocusInput();
              }}
              align={stacked ? "start" : "end"}
              onPick={(handle) => {
                onSetManualTarget(handle);
                if (!handle && autoMention) onDismissAutoMention();
                setPickerOpen(false);
                refocusInput();
              }}
            />
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {draft.length >= COUNTER_THRESHOLD && (
              <span
                aria-live="polite"
                className={`text-[11px] tabular-nums ${remaining < 100 ? "text-destructive" : "text-muted-foreground"}`}
              >
                {remaining} left
              </span>
            )}
            <ShortcutsCheatsheet
              open={cheatsheetOpen}
              onOpenChange={setCheatsheetOpen}
              anchor={wrapperRef}
              agentShortcuts={agentPicker}
            />
            <button
              type="submit"
              disabled={!canSend || busy}
              aria-label={isUploading ? "Waiting for uploads" : "Send message"}
              className={`grid size-7 shrink-0 place-items-center rounded-full transition-all disabled:cursor-not-allowed ${
                canSend && !busy
                  ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95"
                  : "bg-foreground/10 text-muted-foreground"
              }`}
            >
              {busy ? (
                <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"/>
              ) : (
                <ArrowUp className="size-4"/>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

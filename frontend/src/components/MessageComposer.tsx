import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { ArrowDown, ArrowUp, Plus, Reply, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { AgentTargetChip } from "@/components/composer/AgentTargetChip";
import {
  AdminCommandPopover,
  ChannelPopover,
  EmojiShortcodePopover,
  MentionPopover,
  type ChannelItem,
  type EmojiShortcodeItem,
  type MentionItem,
} from "@/components/composer/popovers";
import { AttachmentChip } from "@/components/AttachmentChip";
import type { MessageMentions } from "@/components/MessageMarkdown";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  extractAdminCommandQuery,
  getAdminCommandOptions,
  type AdminCommandDefinition,
} from "@/lib/adminCommands";
import { extractClipboardFiles } from "@/lib/clipboardFiles";
import { modGlyph } from "@/lib/shortcuts/platform";
import { isHereToken } from "@/lib/mentions";
import { quotedBodyText } from "@/lib/messageHelpers";
import type { MmChannelMember, MmChannelPost } from "@/lib/api";
import type { PendingAutoMention } from "@/lib/autoMention";
import type { PendingAttachment } from "@/hooks/useChannelAttachments";

// ----------------------------------------------------------------------------
// Caret-aligned mention highlight overlay. The textarea's text is transparent
// so this overlay supplies the colour; positioning, font, and metrics must
// match the textarea exactly or the caret drifts away from the visible glyph.
// ----------------------------------------------------------------------------

// Highlight either ``@mention`` or ``#channel`` in the composer overlay.
// Same character class as the renderer's TOKEN_RE.
const COMPOSER_MENTION_RE = /@[A-Za-z0-9_.-]+|(?<![A-Za-z0-9_./-])#[A-Za-z0-9_.-]+/g;

function ComposerHighlightedText({
  text,
  mentions,
}: {
  text: string;
  mentions: MessageMentions;
}) {
  if (!text) return null;
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let key = 0;
  for (const match of text.matchAll(COMPOSER_MENTION_RE)) {
    if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index));
    const raw = match[0];
    const token = raw.slice(1).toLowerCase();
    let resolved: boolean;
    if (raw.startsWith("#")) {
      resolved = mentions.channelsByToken?.has(token) ?? false;
    } else {
      const isPrimaryAgent =
        token === mentions.primaryAgentToken?.toLowerCase();
      const isAgent = mentions.agentTokens.has(token);
      const isHuman = mentions.humanTokens.has(token);
      resolved = isHereToken(token) || isPrimaryAgent || isAgent || isHuman;
    }
    const className = resolved ? "text-mention" : "text-muted-foreground/90";
    parts.push(
      <span key={`cm${String(key++)}`} className={className}>
        {raw}
      </span>,
    );
    lastIdx = match.index + raw.length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return <>{parts}</>;
}

function ShortcutsCheatsheet({
  open,
  onOpenChange,
  anchor,
  agentShortcuts,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  anchor: RefObject<HTMLElement | null>;
  agentShortcuts: boolean;
}) {
  const items: { keys: string[]; label: string }[] = [
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
  ].filter((row) => agentShortcuts || !row.keys.includes("J"));
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={anchor}
          align="end"
          side="top"
          sideOffset={8}
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup className="z-50 w-72 origin-(--transform-origin) overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-lg ring-1 ring-foreground/5 backdrop-blur-xl data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <div className="border-b border-border/40 px-3 py-2 text-xs font-medium text-muted-foreground">
              Shortcuts
            </div>
            <div className="flex flex-col gap-0.5 p-1.5">
              {items.map((row) => (
                <div
                  key={row.label}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5"
                >
                  <span className="text-[12px] text-foreground/90">{row.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {row.keys.map((k, i) => (
                      <kbd
                        key={`${k}-${String(i)}`}
                        className="rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-foreground/85"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function SendButton({
  canSend,
  sending,
  uploading,
}: {
  canSend: boolean;
  sending: boolean;
  uploading: boolean;
}) {
  const busy = sending || uploading;
  const ready = canSend && !busy;
  return (
    <button
      type="submit"
      disabled={!ready}
      aria-label={uploading ? "Waiting for uploads" : "Send message"}
      className={`grid size-7 shrink-0 place-items-center rounded-full transition-all disabled:cursor-not-allowed ${
        ready
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
  );
}

// ----------------------------------------------------------------------------
// Main composer.
// ----------------------------------------------------------------------------

const MAX_LEN = 4000;
const COUNTER_THRESHOLD = 3500;

export interface MessageComposerProps {
  /** Mobile shell? Drives ``fixed`` (mobile, keyboard-aware) vs ``absolute``
   *  (desktop, inside the chat column) positioning of the composer wrapper.
   *  Gated on ``useIsMobile()`` upstream. */
  isMobile: boolean;
  /** Top-level positioning wrapper ref — owned by the parent so it can
   *  remeasure the composer's height for scroll-padding. */
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  /** Textarea ref — owned by parent so it can `.focus()` from outside (reply
   *  click, channel switch, jump-to-latest, etc.). */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  channelId: string;

  draft: string;
  onDraftChange: (v: string) => void;
  caretPos: number;
  onCaretPosChange: (v: number) => void;

  // Mention popover
  mentionOpen: boolean;
  mentionOptions: MentionItem[];
  activeMentionIndex: number;
  onActiveMentionIndexChange: (i: number) => void;
  onMentionDismiss: () => void;
  onMentionInsert: (handle: string) => void;

  // Channel popover (``#``)
  channelOpen: boolean;
  channelOptions: ChannelItem[];
  activeChannelIndex: number;
  onActiveChannelIndexChange: (i: number) => void;
  onChannelDismiss: () => void;
  onChannelInsert: (token: string) => void;

  // Emoji shortcode popover
  emojiOpen: boolean;
  emojiOptions: EmojiShortcodeItem[];
  activeEmojiIndex: number;
  onActiveEmojiIndexChange: (i: number) => void;
  onEmojiDismiss: () => void;
  onEmojiInsert: (emoji: string) => void;

  // Context strips
  replyingTo: MmChannelPost | null;
  replyPosterName: (post: MmChannelPost) => string;
  onCancelReply: () => void;

  // Auto-mention (now feeds the agent chip rather than its own strip)
  autoMention: PendingAutoMention | null;
  onDismissAutoMention: () => void;

  // Agent target (new — explicit user-pick state)
  manualTargetHandle: string | null;
  onSetManualTarget: (handle: string | null) => void;

  // Mention highlighting + members
  mentions: MessageMentions;
  members: MmChannelMember[];

  // Attachments
  attachments: PendingAttachment[];
  onAttachmentsAdd: (files: File[] | FileList) => void;
  onAttachmentRemove: (localId: string) => void;
  isUploading: boolean;
  isReadyToSend: boolean;
  uploadedFileIdsCount: number;

  // Send
  onSubmit: () => void;
  /** ArrowUp on an empty composer → edit the user's last message. */
  onEditLast?: () => void;
  isSending: boolean;

  // Jump-to-latest: when the chat is scrolled away from the bottom, a compact
  // button centered above the composer snaps back to the latest message.
  isChatAtBottom: boolean;
  onScrollChatToBottom: () => void;

  // Typing / generating indicator — rendered as a thin row directly
  // above the composer pill (modern convention; see ``TypingRow``).
  // ``activityLabel`` is the text fallback for screen readers;
  // ``activityPeople`` is the live list of peers currently typing or
  // generating (excluding self).
  activityLabel?: string | null;
  activityPeople?: readonly {
    key: string;
    displayName: string;
    status: "typing" | "generating";
  }[];

  /** A DM with an agent: slash commands on, and no agent picker since the
   *  agent is already the target. */
  agentDm: boolean;
  onTyping?: () => void;
  /** Contextual placeholder, e.g. "Message #general" / "Message Anna".
   *  Falls back to the generic prompt. */
  placeholder?: string;
}

/** The composer's translucent surface, shared with the jump-to-latest button. */
const SURFACE =
  "border border-border/60 bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 dark:bg-card/95 dark:supports-[backdrop-filter]:bg-card/85";

export function MessageComposer(props: MessageComposerProps) {
  const {
    isMobile,
    wrapperRef,
    inputRef,
    channelId,
    draft,
    onDraftChange,
    caretPos,
    onCaretPosChange,
    mentionOpen,
    mentionOptions,
    activeMentionIndex,
    onActiveMentionIndexChange,
    onMentionDismiss,
    onMentionInsert,
    channelOpen,
    channelOptions,
    activeChannelIndex,
    onActiveChannelIndexChange,
    onChannelDismiss,
    onChannelInsert,
    emojiOpen,
    emojiOptions,
    activeEmojiIndex,
    onActiveEmojiIndexChange,
    onEmojiDismiss,
    onEmojiInsert,
    replyingTo,
    replyPosterName,
    onCancelReply,
    autoMention,
    onDismissAutoMention,
    manualTargetHandle,
    onSetManualTarget,
    mentions,
    members,
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
    activityLabel,
    activityPeople,
    agentDm,
    onTyping,
    placeholder,
  } = props;

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // The highlight overlay (`data-composer-sizer`) renders the *visible* text;
  // the textarea above it is transparent. Their scroll positions must track
  // each other, or long drafts clip the overlay while the textarea scrolls on.
  const sizerRef = useRef<HTMLDivElement | null>(null);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [wrappedIn, setWrappedIn] = useState<string | null>(null);
  const [activeAdminCommand, setActiveAdminCommand] = useState({ key: "", index: 0 });
  const [dismissedAdminCommandKey, setDismissedAdminCommandKey] = useState<string | null>(null);

  const adminCommandMatch = useMemo(
    () => (agentDm ? extractAdminCommandQuery(draft, caretPos) : null),
    [agentDm, draft, caretPos],
  );
  const adminCommandOptions = useMemo(
    () => (adminCommandMatch ? getAdminCommandOptions(adminCommandMatch.query) : []),
    [adminCommandMatch],
  );
  const adminCommandKey = adminCommandMatch
    ? `${String(adminCommandMatch.start)}:${String(adminCommandMatch.end)}:${adminCommandMatch.query}`
    : null;
  const activeAdminCommandIndex = adminCommandKey && activeAdminCommand.key === adminCommandKey
    ? Math.min(activeAdminCommand.index, Math.max(adminCommandOptions.length - 1, 0))
    : 0;
  const adminCommandDismissed = adminCommandKey != null && dismissedAdminCommandKey === adminCommandKey;
  const adminCommandOpen = Boolean(
    agentDm && !adminCommandDismissed && adminCommandMatch && adminCommandOptions.length > 0,
  );

  // Wrap the current textarea selection with markdown syntax. Empty-selection
  // case inserts a placeholder and selects it so the user can over-type
  // (so "Bold" with no selection becomes ``**bold text**`` with "bold text"
  // pre-selected, ready to be replaced).
  const applyMarkdownFormat = useCallback(
    (prefix: string, suffix: string, placeholder: string) => {
      const ta = inputRef.current;
      if (!ta) return;
      const start = ta.selectionStart ?? draft.length;
      const end = ta.selectionEnd ?? draft.length;
      const hasSelection = start !== end;
      const selected = hasSelection ? draft.slice(start, end) : placeholder;
      const before = draft.slice(0, start);
      const after = draft.slice(end);
      const newDraft = before + prefix + selected + suffix + after;
      onDraftChange(newDraft);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const newStart = start + prefix.length;
        const newEnd = newStart + selected.length;
        el.setSelectionRange(newStart, newEnd);
        onCaretPosChange(newEnd);
      });
    },
    [draft, inputRef, onCaretPosChange, onDraftChange],
  );

  // Restore focus to the textarea after any chrome-level action (file picker,
  // agent chip pick/clear). Without this the caret jumps to the trigger
  // button and the user has to click back into the message field — a
  // friction the user explicitly called out.
  const refocusInput = useCallback(() => {
    requestAnimationFrame(() => { inputRef.current?.focus(); });
  }, [inputRef]);

  const insertAdminCommand = useCallback(
    (command: AdminCommandDefinition) => {
      const match = extractAdminCommandQuery(
        draft,
        inputRef.current?.selectionStart ?? caretPos,
      );
      if (!match) return;
      const replacement = `${command.command} `;
      const next = `${draft.slice(0, match.start)}${replacement}${draft.slice(match.end)}`;
      onDraftChange(next);
      setDismissedAdminCommandKey(null);
      const nextCaret = match.start + replacement.length;
      onCaretPosChange(nextCaret);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [caretPos, draft, inputRef, onCaretPosChange, onDraftChange],
  );

  // Agents currently in the channel — drives chip visibility and the picker.
  // Exclude agents the viewer may not tag (contact is closed by default); the
  // server would reject the mention anyway. ``can_tag == null`` means the
  // payload didn't compute it — treat as allowed for back-compat.
  const agents = useMemo(
    () =>
      members.filter(
        (m): m is MmChannelMember & { agent_id: string } =>
          m.agent_id != null && m.can_tag !== false,
      ),
    [members],
  );

  const effectiveTargetHandle = manualTargetHandle ?? autoMention?.handle ?? null;
  const agentPicker = !agentDm && agents.length > 0;

  const clearTarget = useCallback(() => {
    if (manualTargetHandle) {
      onSetManualTarget(null);
    } else if (autoMention) {
      onDismissAutoMention();
    }
  }, [manualTargetHandle, autoMention, onSetManualTarget, onDismissAutoMention]);

  const cycleAgent = useCallback(() => {
    if (agents.length === 0) return;
    const i = effectiveTargetHandle
      ? agents.findIndex((a) => a.agent_id === effectiveTargetHandle)
      : -1;
    const next = agents[(i + 1) % agents.length];
    if (next) onSetManualTarget(next.agent_id);
  }, [agents, effectiveTargetHandle, onSetManualTarget]);

  const trimmed = draft.trim();
  const hasContent = trimmed.length > 0 || attachments.length > 0;
  const canSend =
    hasContent &&
    isReadyToSend &&
    (trimmed.length > 0 || uploadedFileIdsCount > 0);

  // ---- Keyboard handling --------------------------------------------------
  // Ordering matters: popovers win, then reply/target cancel, then send.
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Slash command popover navigation
    if (adminCommandOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveAdminCommand({
          key: adminCommandKey ?? "",
          index: (activeAdminCommandIndex + 1) % adminCommandOptions.length,
        });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveAdminCommand({
          key: adminCommandKey ?? "",
          index: (activeAdminCommandIndex - 1 + adminCommandOptions.length) % adminCommandOptions.length,
        });
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const choice = adminCommandOptions[activeAdminCommandIndex];
        if (choice) insertAdminCommand(choice);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (adminCommandKey) setDismissedAdminCommandKey(adminCommandKey);
        return;
      }
    }

    // Mention popover navigation
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        onActiveMentionIndexChange((activeMentionIndex + 1) % mentionOptions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        onActiveMentionIndexChange(
          (activeMentionIndex - 1 + mentionOptions.length) % mentionOptions.length,
        );
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const choice = mentionOptions[activeMentionIndex];
        if (choice) onMentionInsert(choice.handle);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onMentionDismiss();
        return;
      }
    }
    // Channel popover navigation — same shape as mention.
    if (channelOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        onActiveChannelIndexChange((activeChannelIndex + 1) % channelOptions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        onActiveChannelIndexChange(
          (activeChannelIndex - 1 + channelOptions.length) % channelOptions.length,
        );
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const choice = channelOptions[activeChannelIndex];
        if (choice) onChannelInsert(choice.token);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onChannelDismiss();
        return;
      }
    }
    // Emoji-shortcode popover navigation
    if (emojiOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        onActiveEmojiIndexChange((activeEmojiIndex + 1) % emojiOptions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        onActiveEmojiIndexChange(
          (activeEmojiIndex - 1 + emojiOptions.length) % emojiOptions.length,
        );
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const choice = emojiOptions[activeEmojiIndex];
        if (choice) onEmojiInsert(choice.emoji);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onEmojiDismiss();
        return;
      }
    }

    // Empty composer + ArrowUp → edit the user's last message (the
    // Slack/Discord quick-edit gesture). No autocomplete popover is open
    // here (handled above) and the field is genuinely empty, so this never
    // hijacks cursor movement within a draft.
    if (
      e.key === "ArrowUp" &&
      draft.length === 0 &&
      !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey &&
      !e.nativeEvent.isComposing &&
      onEditLast
    ) {
      e.preventDefault();
      onEditLast();
      return;
    }

    // Cheatsheet
    if ((e.metaKey || e.ctrlKey) && e.key === "/") {
      e.preventDefault();
      setCheatsheetOpen((v) => !v);
      return;
    }

    // Markdown bold/italic
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        applyMarkdownFormat("**", "**", "bold text");
        return;
      }
      if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        applyMarkdownFormat("*", "*", "italic text");
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && (e.key === "J" || e.key === "j")) {
      e.preventDefault();
      if (!agentPicker) return;
      if (e.shiftKey) cycleAgent();
      else setPickerOpen((v) => !v);
      return;
    }

    // Escape ladder: cheatsheet → reply → target. Clearing the target keeps
    // the draft.
    if (e.key === "Escape") {
      if (cheatsheetOpen) {
        e.preventDefault();
        setCheatsheetOpen(false);
        return;
      }
      if (replyingTo) {
        e.preventDefault();
        onCancelReply();
        return;
      }
      if (effectiveTargetHandle) {
        e.preventDefault();
        clearTarget();
        return;
      }
    }

    // Send on plain Enter (Shift+Enter falls through as newline).
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };

  const remaining = MAX_LEN - draft.length;
  const showCounter = draft.length >= COUNTER_THRESHOLD;

  const wrapped = wrappedIn === channelId;
  if (wrapped && draft === "") setWrappedIn(null);
  const stacked = wrapped || draft.includes("\n") || replyingTo != null || attachments.length > 0;

  useEffect(() => {
    const el = sizerRef.current;
    if (!el) return;
    const line = parseFloat(getComputedStyle(el).lineHeight);
    const ro = new ResizeObserver(() => {
      if (el.offsetHeight > line * 1.5) flushSync(() => { setWrappedIn(channelId); });
    });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, [channelId]);

  return (
    <div
      ref={wrapperRef}
      data-glass={isMobile ? "" : undefined}
      // ABSOLUTE inside the chat column on every platform. The mobile shell is a
      // fixed-viewport box sized to ``--vvh``; when the keyboard opens the shell
      // (and this column) shrink, so an ``absolute bottom-0`` composer rises with
      // it automatically — no ``fixed`` + ``translateY(-kb-inset)`` needed. The
      // ``pb`` clears the home indicator (safe-area, floored at 0.5rem on mobile;
      // a no-op on desktop where --safe-bottom is 0).
      className={
        isMobile
          ? "pointer-events-none absolute inset-x-0 bottom-0 z-10 px-2 pb-[max(0.5rem,var(--safe-bottom))]"
          : "pointer-events-none absolute inset-x-0 bottom-2.5 z-10 px-3 pb-[var(--safe-bottom)] max-md:px-2"
      }
    >
      {/* Outer wrapper spans full width for the height-measurement observer
          in ChannelPage; inner ``max-w-chat`` keeps the composer pill the
          same width as the message column. The extra ``px-0.5`` mirrors the
          message rows' ``mx-0.5`` inset so the pill's edges line up exactly
          with the rows rather than overhanging them by 2px each side. */}
      <div className="pointer-events-auto relative mx-auto max-w-chat px-0.5">
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
        {adminCommandOpen && (
          <AdminCommandPopover
            options={adminCommandOptions}
            activeIndex={activeAdminCommandIndex}
            query={adminCommandMatch?.query ?? ""}
            onSelect={insertAdminCommand}
          />
        )}
        {mentionOpen && !adminCommandOpen && (
          <MentionPopover
            options={mentionOptions}
            activeIndex={activeMentionIndex}
            onSelect={onMentionInsert}
          />
        )}
        {channelOpen && !adminCommandOpen && !mentionOpen && (
          <ChannelPopover
            options={channelOptions}
            activeIndex={activeChannelIndex}
            onSelect={onChannelInsert}
          />
        )}
        {emojiOpen && !adminCommandOpen && !mentionOpen && !channelOpen && (
          <EmojiShortcodePopover
            options={emojiOptions}
            activeIndex={activeEmojiIndex}
            onSelect={onEmojiInsert}
          />
        )}
        <TypingRow people={activityPeople ?? []} label={activityLabel ?? null}/>
        <form
          data-stacked={stacked ? "" : undefined}
          className={cn(
            SURFACE,
            "group/composer flex flex-wrap items-center gap-1.5 rounded-[22px] p-[7px] transition-colors focus-within:border-border/80 data-stacked:rounded-[18px]",
          )}
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {replyingTo && (
            <div className="order-first flex min-w-0 basis-full items-center gap-2 pt-0.5 pl-[7px] text-xs text-muted-foreground">
              <Reply className="size-3.5 shrink-0"/>
              <span className="min-w-0 flex-1 truncate">
                Replying to <span className="font-medium text-foreground">{replyPosterName(replyingTo)}</span>
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
              if (e.target.files && e.target.files.length > 0) {
                onAttachmentsAdd(e.target.files);
                e.target.value = "";
                refocusInput();
              }
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
                onDraftChange(e.target.value);
                onCaretPosChange(e.target.selectionStart ?? e.target.value.length);
                if (e.target.value.length > 0) onTyping?.();
              }}
              onClick={(e) => { onCaretPosChange(e.currentTarget.selectionStart ?? 0); }}
              onKeyUp={(e) => { onCaretPosChange(e.currentTarget.selectionStart ?? 0); }}
              onSelect={(e) => { onCaretPosChange(e.currentTarget.selectionStart ?? 0); }}
              onKeyDown={handleKeyDown}
              onScroll={(e) => {
                const sizer = sizerRef.current;
                if (sizer) sizer.scrollTop = e.currentTarget.scrollTop;
              }}
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
              targetHandle={effectiveTargetHandle}
              open={pickerOpen}
              onOpenChange={(o, refocus) => {
                setPickerOpen(o);
                if (refocus) refocusInput();
              }}
              align={stacked ? "start" : "end"}
              onPick={(h) => {
                onSetManualTarget(h);
                if (!h && autoMention) onDismissAutoMention();
                setPickerOpen(false);
                refocusInput();
              }}
            />
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {showCounter && (
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
            <SendButton canSend={canSend} sending={isSending} uploading={isUploading}/>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Peer typing/generating indicator. Renders as a thin, no-background
 * row directly above the composer pill — the conventional position in
 * modern chat clients (iMessage, Telegram, WhatsApp). Multiple typers
 * collapse into one line ("Anna and 2 others are typing") so the
 * bottom action bar stays uncluttered. The bouncing dots stand in for
 * the trailing ellipsis, so the verb is left bare.
 *
 * The dot animation lives in ``index.css`` (``@keyframes typing-dot``).
 * The row's slide-fade entrance lives in ``@keyframes typing-row-in``,
 * also in ``index.css``.
 */
function TypingRow({
  people,
  label,
}: {
  people: readonly {
    key: string;
    displayName: string;
    status: "typing" | "generating";
  }[];
  label?: string | null;
}) {
  // Reserve the slot unconditionally so the message viewport doesn't
  // reflow when typing starts/stops — the text itself mounts only when
  // there's someone to show. Height tracks the indicator's 11px text
  // with just a few px of breathing room to keep the gap to the last
  // message tight.
  if (people.length === 0) {
    return <div aria-hidden className="h-4"/>;
  }

  // "thinking" reads more naturally for agents that are mid-generation;
  // a mixed group still falls back to "typing" so the verb matches the
  // dominant intent (most clients only ever show one or the other).
  const allGenerating = people.every((p) => p.status === "generating");
  const verb = allGenerating ? "thinking" : "typing";
  const auxiliary = people.length > 1 ? "are" : "is";

  let nameText: string;
  if (people.length === 1) {
    nameText = people[0]!.displayName;
  } else if (people.length === 2) {
    nameText = `${people[0]!.displayName} and ${people[1]!.displayName}`;
  } else {
    nameText = `${people[0]!.displayName} and ${String(people.length - 1)} others`;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label ?? `${nameText} ${auxiliary} ${verb}`}
      className="animate-typing-row-in flex h-4 min-w-0 items-center gap-1.5 px-3.5 text-[11px] text-muted-foreground"
    >
      <span className="inline-flex shrink-0 items-center gap-[2px]" aria-hidden="true">
        <span className="typing-dot block size-[3.5px] rounded-full bg-muted-foreground"/>
        <span className="typing-dot block size-[3.5px] rounded-full bg-muted-foreground"/>
        <span className="typing-dot block size-[3.5px] rounded-full bg-muted-foreground"/>
      </span>
      <span className="min-w-0 truncate">{nameText} {auxiliary} {verb}</span>
    </div>
  );
}

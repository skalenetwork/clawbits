import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowTurnBackwardIcon,
  Attachment01Icon,
  Clock01Icon,
  Copy01Icon,
  Delete02Icon,
  Edit02Icon,
  Link01Icon,
  PinIcon,
  PinOffIcon,
  SmilePlusIcon,
  Tick02Icon,
  TickDouble02Icon,
} from "@hugeicons/core-free-icons";

import { AdminCommandGlyph } from "@/components/AdminCommandGlyph";
import { Icon } from "@/components/Icon";
import { LinkPreviewCard } from "@/components/LinkPreviewCard";
import { MessageAttachments } from "@/components/MessageAttachments";
import { MessageMarkdown } from "@/components/MessageMarkdown";
import { MessagePostContext } from "@/components/messagePostContext";
import { ProfileMenuTrigger } from "@/components/ProfileMenu";
import { GeneratingIndicator } from "@/components/chat/GeneratingIndicator";
import { PostAvatar } from "@/components/chat/PostAvatar";
import { TurnTrace } from "@/components/chat/TurnTrace";
import { StreamingMarkdown } from "@/components/chat/StreamingMarkdown";
import { SettleBody } from "@/components/chat/SettleBody";
import { EmojiGrid, ReactionEmojiPicker } from "@/components/chat/ReactionEmojiPicker";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLongPress } from "@/hooks/useLongPress";
import { useSmoothedText } from "@/hooks/useSmoothedText";
import type { AgentActivity, ThinkingStep, ToolStep } from "@/hooks/useChannelEvents";
import { isMcpSignInLink, type MmChannelMember, type MmChannelPost, type MmChannelType } from "@/lib/api";
import { isPairType } from "@/lib/chatFilters";
import { matchAdminCommandText } from "@/lib/adminCommands";
import { burstEmojiAt, burstEmojiFrom } from "@/lib/emojiBurst";
import { extractUrls } from "@/lib/extractUrls";
import { formatRelativeAgo, formatTimeOnly, postMoments } from "@/lib/formatting";
import { mentionHandle, messageLink, posterName, quotedBodyText } from "@/lib/messageHelpers";
import { MENU_SURFACE } from "@/lib/menuSurface";
import { formatReactors } from "@/lib/reactionTooltip";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface MessageAction {
  key: string;
  icon: typeof Copy01Icon;
  label: string;
  onClick: () => void;
}

const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "😮", "😢"] as const;
const ACTION_BUTTON =
  "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
const KBD = "rounded border border-border/60 bg-muted/40 px-1 py-px font-mono text-[10px]";
const QR_PANEL_W = 332;
const QR_GAP = 6;
const QR_MARGIN = 8;
const QR_ROW_H = 44;

const RECEIPTS = {
  sending: { icon: Clock01Icon, label: "Sending", className: "text-muted-foreground/60" },
  delivered: { icon: Tick02Icon, label: "Delivered", className: "text-muted-foreground/80" },
  read: { icon: TickDouble02Icon, label: "Read", className: "text-sky-500 dark:text-sky-400" },
};

function centerOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function copyToClipboard(text: string, ok: string): void {
  navigator.clipboard.writeText(text).then(
    () => { toast.success(ok); },
    () => { toast.error("Copy failed"); },
  );
}

function receiptOf(
  post: MmChannelPost,
  channelType: MmChannelType | undefined,
  currentUserId: number | null,
  members: MmChannelMember[],
) {
  if (!isPairType(channelType) || currentUserId == null) return null;
  if (post.human_id !== currentUserId || post.agent_id != null) return null;
  if (post.status === "draft" || post.status === "rejected") return null;
  if (post.post_id < 0 || post.status === "streaming") return RECEIPTS.sending;
  if (post.status !== "published") return null;
  const peer = members.find((m) => (m.human_id != null && m.human_id !== currentUserId) || m.agent_id != null);
  return (peer?.last_read_post_id ?? -1) >= post.post_id ? RECEIPTS.read : RECEIPTS.delivered;
}

function QuickReactionsPopover({
  rect,
  triggerRef,
  popoverRef,
  onSelect,
}: {
  rect: DOMRect;
  triggerRef: RefObject<HTMLButtonElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  onSelect: (emoji: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const spaceAbove = rect.top - QR_GAP - QR_MARGIN - QR_ROW_H;
  const spaceBelow = window.innerHeight - rect.bottom - QR_GAP - QR_MARGIN - QR_ROW_H;
  const openUp = spaceAbove >= spaceBelow;
  const style: CSSProperties = {
    position: "fixed",
    zIndex: 30,
    right: Math.max(QR_MARGIN, window.innerWidth - rect.right),
    width: expanded ? QR_PANEL_W : undefined,
    ...(openUp ? { bottom: window.innerHeight - rect.top + QR_GAP } : { top: rect.bottom + QR_GAP }),
  };
  const grid = expanded && (
    <div className="border-border/40" style={openUp ? { borderBottomWidth: 1 } : { borderTopWidth: 1 }}>
      <EmojiGrid
        height={Math.max(200, Math.min(330, openUp ? spaceAbove : spaceBelow))}
        onSelect={(emoji) => { burstEmojiFrom(emoji, triggerRef.current); onSelect(emoji); }}
      />
    </div>
  );

  return createPortal(
    <div
      ref={popoverRef}
      role="menu"
      aria-label="Pick a reaction"
      style={style}
      className={cn(MENU_SURFACE, "flex flex-col gap-1 duration-100 animate-in fade-in-0 zoom-in-95")}
    >
      {openUp && grid}
      <div className="flex items-center justify-end gap-0.5">
        {QUICK_REACTIONS.map((e) => (
          <button
            key={e}
            type="button"
            role="menuitem"
            aria-label={`React with ${e}`}
            onClick={(ev) => { burstEmojiFrom(e, ev.currentTarget); onSelect(e); }}
            className="flex size-8 items-center justify-center rounded-md text-[18px] leading-none outline-hidden hover:bg-accent focus-visible:bg-accent"
          >
            {e}
          </button>
        ))}
        <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-foreground/8"/>
        <button
          type="button"
          aria-label={expanded ? "Fewer emoji" : "More emoji"}
          aria-expanded={expanded}
          onClick={() => { setExpanded((v) => !v); }}
          className={cn(
            "flex size-8 items-center justify-center rounded-md outline-hidden",
            expanded ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Icon icon={SmilePlusIcon} className="size-4"/>
        </button>
      </div>
      {!openUp && grid}
    </div>,
    document.body,
  );
}

function ReactionQuickPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const open = rect != null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) setRect(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setRect(null);
      triggerRef.current?.focus();
    };
    const onScroll = (e: Event) => {
      if (!popoverRef.current?.contains(e.target as Node)) setRect(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  return (
    <div className="relative">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={triggerRef}
              type="button"
              aria-label="React"
              aria-expanded={open}
              onClick={(e) => { setRect(open ? null : e.currentTarget.getBoundingClientRect()); }}
              className={ACTION_BUTTON}
            >
              <Icon icon={SmilePlusIcon} className="size-3.5"/>
            </button>
          }
        />
        <TooltipContent side="top" sideOffset={4} className="text-xs">React</TooltipContent>
      </Tooltip>
      {rect && (
        <QuickReactionsPopover
          rect={rect}
          triggerRef={triggerRef}
          popoverRef={popoverRef}
          onSelect={(emoji) => { onSelect(emoji); setRect(null); }}
        />
      )}
    </div>
  );
}

function InlineMessageEditor({
  initialText,
  onSave,
  onCancel,
  saving,
}: {
  initialText: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [text, setText] = useState(initialText);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  const trimmed = text.trim();
  const canSave = trimmed.length > 0 && trimmed !== initialText.trim() && !saving;

  return (
    <div className="my-1 flex flex-col rounded-lg border border-border/50 bg-background/80 transition-colors focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/15">
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => { setText(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSave) onSave(trimmed);
          }
        }}
        maxLength={4000}
        spellCheck
        className="min-h-9 max-h-40 w-full resize-none border-0 bg-transparent px-3 pt-2.5 pb-1 text-message outline-none focus-visible:ring-0 [field-sizing:content]"
      />
      <div className="flex items-center gap-2 px-2.5 pt-0.5 pb-2 text-[11px] text-muted-foreground">
        <span>
          <kbd className={KBD}>↵</kbd> save
          {" · "}
          <kbd className={KBD}>esc</kbd> cancel
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button type="button" size="xs" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            size="xs"
            variant="default"
            onClick={() => { onSave(trimmed); }}
            disabled={!canSave}
            className={canSave ? "" : "bg-muted/60 text-muted-foreground hover:bg-muted/60"}
          >
            Save
          </Button>
        </span>
      </div>
    </div>
  );
}

function ReactionsStrip({
  reactions,
  members,
  currentUserId,
  onToggle,
}: {
  reactions: NonNullable<MmChannelPost["reactions"]>;
  members: MmChannelMember[];
  currentUserId: number | null;
  onToggle: (emoji: string) => void;
}) {
  const visible = reactions.length > 0;
  return (
    <div
      aria-hidden={!visible}
      className={`grid transition-[grid-template-rows,margin-top,margin-bottom] duration-200 ease-out ${
        visible ? "mt-1.5 mb-2 grid-rows-[1fr]" : "mt-0 mb-0 grid-rows-[0fr]"
      }`}
    >
      <div className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-1.5">
          {reactions.map((r) => {
            const reactedByMe = currentUserId != null && r.human_ids.includes(currentUserId);
            const reactorLine = formatReactors(r, members, currentUserId);
            return (
              <Tooltip key={r.emoji}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={(e) => {
                        if (!reactedByMe) burstEmojiFrom(r.emoji, e.currentTarget);
                        onToggle(r.emoji);
                      }}
                      className={`flex items-center gap-2 rounded-full px-2.5 py-1.5 text-[14px] leading-none transition-[color,background-color,transform] duration-150 active:scale-[0.94] ${
                        reactedByMe
                          ? "bg-foreground/[0.14] text-foreground hover:bg-foreground/20"
                          : "bg-muted/35 text-muted-foreground hover:bg-muted/55 hover:text-foreground"
                      }`}
                    >
                      <span className="text-[17px] leading-none">{r.emoji}</span>
                      <span className="font-medium tabular-nums">{r.count}</span>
                    </button>
                  }
                />
                <TooltipContent
                  side="top"
                  sideOffset={6}
                  className="max-w-xs flex-col items-center gap-1 px-3 py-2 text-center text-[11px]"
                >
                  {reactorLine ? (
                    <>
                      <span className="text-[20px] leading-none">{r.emoji}</span>
                      <span className="text-background/90">{reactorLine}</span>
                    </>
                  ) : (
                    <span>{r.emoji}</span>
                  )}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PostTime({ post, className }: { post: MmChannelPost; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={1200}
        render={
          <span className={cn("shrink-0 cursor-default text-[11px] tabular-nums text-muted-foreground", className)}>
            {formatTimeOnly(post.created_at)}
          </span>
        }
      />
      <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[11px]">
        <PostMoments post={post}/>
      </TooltipContent>
    </Tooltip>
  );
}

function PostMoments({ post }: { post: MmChannelPost }) {
  return (
    <dl className="grid grid-cols-[auto_auto] gap-x-2 gap-y-0.5">
      {postMoments(post).flatMap(({ label, at }) => [
        <dt key={label} className="opacity-60">{label}</dt>,
        <dd key={`${label}-at`} className="tabular-nums">{at}</dd>,
      ])}
    </dl>
  );
}

function EditedIndicator({ editedAt }: { editedAt: string }) {
  const ago = formatRelativeAgo(editedAt);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex shrink-0 cursor-default items-center align-middle text-muted-foreground"
            aria-label="Edited"
          >
            <Icon icon={Edit02Icon} className="size-3" aria-hidden />
          </span>
        }
      />
      <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[11px]">
        {ago ? `Edited ${ago}` : "Edited"}
      </TooltipContent>
    </Tooltip>
  );
}

function MessageActionsBar({
  actions,
  leading,
  className,
}: {
  actions: MessageAction[];
  leading: ReactNode;
  className: string;
}) {
  return (
    <div
      className={cn(
        "invisible flex items-center gap-0.5 opacity-0 transition-[opacity,visibility] group-hover/row:visible group-hover/row:opacity-100 group-hover/row:delay-400",
        className,
      )}
      role="toolbar"
      aria-label="Message actions"
    >
      {leading}
      {actions.map((a) => (
        <Tooltip key={a.key}>
          <TooltipTrigger
            render={
              <button type="button" onClick={a.onClick} aria-label={a.label} className={ACTION_BUTTON}>
                <Icon icon={a.icon} className="size-3.5"/>
              </button>
            }
          />
          <TooltipContent side="top" sideOffset={4} className="text-xs">{a.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function MessageActionsSheet({
  open,
  onOpenChange,
  actions,
  reactable,
  onReact,
  onMore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: MessageAction[];
  reactable: boolean;
  onReact: (emoji: string) => void;
  onMore: (anchor: { x: number; y: number }) => void;
}) {
  // Close first so a Reply or Edit that focuses the composer does not fight the drawer's focus trap.
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        {reactable && (
          <div className="flex items-center justify-between px-1 pb-3">
            {QUICK_REACTIONS.map((e) => (
              <button
                key={e}
                type="button"
                aria-label={`React with ${e}`}
                onClick={(ev) => {
                  burstEmojiFrom(e, ev.currentTarget);
                  run(() => { onReact(e); });
                }}
                className="flex size-12 items-center justify-center rounded-full text-[26px] leading-none transition active:scale-90 active:bg-foreground/10"
              >
                {e}
              </button>
            ))}
            <button
              type="button"
              aria-label="More emoji"
              onClick={(ev) => {
                const anchor = centerOf(ev.currentTarget);
                run(() => { onMore(anchor); });
              }}
              className="flex size-12 items-center justify-center rounded-full text-muted-foreground transition active:scale-90 active:bg-foreground/10"
            >
              <Icon icon={SmilePlusIcon} className="size-6"/>
            </button>
          </div>
        )}
        <div className="flex flex-col pb-2">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => { run(a.onClick); }}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left text-[15px] transition active:bg-foreground/5",
                a.key === "delete" ? "text-destructive" : "text-foreground",
              )}
            >
              <Icon icon={a.icon} className="size-5" />
              {a.label}
            </button>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function ParentQuoteBlock({
  preview,
  onJump,
}: {
  preview: NonNullable<MmChannelPost["parent_preview"]>;
  onJump: (postId: number) => void;
}) {
  const authorName =
    preview.poster_display_name
    ?? preview.agent_id
    ?? (preview.human_id != null ? `User ${String(preview.human_id)}` : "Unknown");
  const attachmentCount = preview.attachment_count ?? 0;
  return (
    <button
      type="button"
      onClick={() => { onJump(preview.post_id); }}
      className="mt-1 mb-1 flex w-full max-w-[28rem] items-stretch gap-2 rounded-md bg-muted/35 py-1 pl-2.5 pr-2.5 text-left transition-colors hover:bg-muted/55"
      aria-label={`Jump to message from ${authorName}`}
    >
      <span aria-hidden className="w-0.5 shrink-0 rounded-full bg-primary/60"/>
      <span className="min-w-0 flex-1 leading-snug">
        {preview.status === "rejected" ? (
          <span className="block truncate text-[12px] italic text-muted-foreground">
            Original message removed
          </span>
        ) : (
          <>
            <span className="block truncate text-[12px] font-medium text-foreground/85">{authorName}</span>
            <span className="flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">
              {!preview.message_excerpt.trim() && attachmentCount > 0 && (
                <Icon icon={Attachment01Icon} className="size-2.5! shrink-0 opacity-70"/>
              )}
              <span className="min-w-0 truncate">
                {quotedBodyText(preview.message_excerpt, attachmentCount)}
              </span>
            </span>
          </>
        )}
      </span>
    </button>
  );
}

function DraftBody({
  text,
  activity,
  toolSteps,
  thinkingSteps,
  agentId,
}: {
  text: string;
  activity?: AgentActivity;
  toolSteps?: ToolStep[];
  thinkingSteps?: ThinkingStep[];
  agentId?: string;
}) {
  const smoothed = useSmoothedText(text, true);
  if (!smoothed) {
    return (
      <div className="text-message text-muted-foreground">
        <GeneratingIndicator
          activity={activity}
          toolSteps={toolSteps}
          thinkingSteps={thinkingSteps}
          agentId={agentId}
        />
      </div>
    );
  }
  return (
    <div>
      <StreamingMarkdown text={smoothed} />
      <TurnTrace toolSteps={toolSteps} thinkingSteps={thinkingSteps} sealed />
    </div>
  );
}

interface MessageRowProps {
  post: MmChannelPost;
  currentUserId: number | null;
  isChannelCreator: boolean;
  isGroupStart: boolean;
  activity?: AgentActivity;
  toolSteps?: ToolStep[];
  thinkingSteps?: ThinkingStep[];
  finishedToolSteps?: ToolStep[];
  finishedThinkingSteps?: ThinkingStep[];
  members: MmChannelMember[];
  channelType: MmChannelType | undefined;
  onReply: (post: MmChannelPost) => void;
  onJumpToParent: (postId: number) => void;
  onToggleReaction: (vars: { postId: number; emoji: string }) => void;
  onTogglePin: (post: MmChannelPost) => void;
  isEditing: boolean;
  onEdit: (postId: number | null) => void;
  onSaveEdit: (vars: { postId: number; message: string }) => void;
  editSaving: boolean;
  onDelete: (postId: number) => void;
  highlighted: boolean;
  queued: boolean;
}

export const MessageRow = memo(function MessageRow({
  post,
  currentUserId,
  isChannelCreator,
  isGroupStart,
  activity,
  toolSteps,
  thinkingSteps,
  finishedToolSteps,
  finishedThinkingSteps,
  members,
  channelType,
  onReply,
  onJumpToParent,
  onToggleReaction,
  onTogglePin,
  isEditing,
  onEdit,
  onSaveEdit,
  editSaving,
  onDelete,
  highlighted,
  queued,
}: MessageRowProps) {
  const [emojiPicker, setEmojiPicker] = useState<{ x: number; y: number } | null>(null);
  const [actionsSheetOpen, setActionsSheetOpen] = useState(false);
  const [actionsMounted, setActionsMounted] = useState(false);
  // Touch long-press fires a native contextmenu too, so the right-click menu is for fine pointers only.
  const [canRightClick] = useState(() => window.matchMedia("(pointer: fine)").matches);

  const isStreaming = post.status === "streaming";
  const isDraft = post.status === "draft";
  const isRejected = post.status === "rejected";
  const isPublished = post.status === "published";
  const isPinned = post.pinned_at != null;
  const isOwnHumanPost = currentUserId != null && post.human_id === currentUserId && post.agent_id == null;
  const hasActions = !isStreaming && !isDraft && !isEditing;
  const settled = hasActions && !isRejected;

  const longPress = useLongPress(() => {
    if (hasActions) setActionsSheetOpen(true);
  });

  const authorMember = useMemo((): MmChannelMember | null => {
    if (post.agent_id == null && post.human_id == null) return null;
    return members.find((m) => (post.agent_id != null ? m.agent_id === post.agent_id : m.human_id === post.human_id)) ?? {
      agent_id: post.agent_id,
      human_id: post.human_id,
      display_name: post.poster_display_name,
      joined_at: post.created_at,
      status: null,
      last_seen_at: null,
      avatar: post.avatar ?? null,
    };
  }, [members, post.agent_id, post.human_id, post.poster_display_name, post.created_at, post.avatar]);

  const react = (emoji: string) => { onToggleReaction({ postId: post.post_id, emoji }); };
  const mountActions = () => { setActionsMounted(true); };

  const actions: MessageAction[] = hasActions
    ? [
        settled && { key: "reply", icon: ArrowTurnBackwardIcon, label: "Reply", onClick: () => { onReply(post); } },
        isOwnHumanPost && isPublished && {
          key: "edit",
          icon: Edit02Icon,
          label: "Edit",
          onClick: () => { onEdit(post.post_id); },
        },
        isPublished && {
          key: "pin",
          icon: isPinned ? PinOffIcon : PinIcon,
          label: isPinned ? "Unpin from channel" : "Pin to channel",
          onClick: () => { onTogglePin(post); },
        },
        { key: "copy", icon: Copy01Icon, label: "Copy", onClick: () => { copyToClipboard(post.message, "Copied"); } },
        {
          key: "copy-link",
          icon: Link01Icon,
          label: "Copy link",
          onClick: () => { copyToClipboard(messageLink(post.channel_id, post.post_id), "Link copied"); },
        },
        (isOwnHumanPost || isChannelCreator) && (isPublished || isRejected) && {
          key: "delete",
          icon: Delete02Icon,
          label: "Delete",
          onClick: () => { onDelete(post.post_id); },
        },
      ].filter((a) => a !== false)
    : [];

  const adminCommand = isOwnHumanPost && channelType === "direct" && members.some((m) => m.agent_id != null)
    ? matchAdminCommandText(post.message)
    : null;
  const body = isStreaming ? (
    <DraftBody
      text={post.message}
      agentId={post.agent_id ?? undefined}
      activity={activity}
      toolSteps={toolSteps}
      thinkingSteps={thinkingSteps}
    />
  ) : isEditing ? (
    <InlineMessageEditor
      initialText={post.message}
      saving={editSaving}
      onSave={(message) => { onSaveEdit({ postId: post.post_id, message }); }}
      onCancel={() => { onEdit(null); }}
    />
  ) : adminCommand ? (
    <div className="my-1 inline-flex max-w-full items-center gap-2 rounded-full border border-border/60 bg-muted/60 px-2.5 py-1 text-foreground/80">
      <AdminCommandGlyph kind={adminCommand.kind} className="size-5" />
      <code className="min-w-0 shrink-0 truncate font-mono text-[13px] font-semibold leading-none tracking-tight text-foreground">
        {adminCommand.command}
      </code>
      <span aria-hidden className="hidden size-0.5 shrink-0 rounded-full bg-muted-foreground/60 sm:block"/>
      <span className="hidden min-w-0 truncate text-[12px] font-medium leading-none text-muted-foreground sm:inline">
        {adminCommand.description}
      </span>
    </div>
  ) : (
    <>
      <MessagePostContext value={post.post_id}><MessageMarkdown content={post.message}/></MessagePostContext>
      <TurnTrace toolSteps={finishedToolSteps} thinkingSteps={finishedThinkingSteps} sealed />
    </>
  );

  const previewUrl = settled && !post.link_preview ? extractUrls(post.message).find((url) => !isMcpSignInLink(url)) : undefined;
  const reactionPicker = settled && <ReactionQuickPicker onSelect={react}/>;
  const receipt = receiptOf(post, channelType, currentUserId, members);
  const handleText = authorMember ? `@${mentionHandle(authorMember)}` : "@user";

  const row = (
    <div
      data-post-id={post.post_id}
      {...longPress}
      onPointerEnter={mountActions}
      onFocus={mountActions}
      className={`group/row relative mx-0.5 rounded-lg pl-14 pr-3 transition-colors duration-500 ${
        isGroupStart ? "mt-4 pt-1.5 pb-0.5" : "mt-1.5 min-w-0 py-0.5"
      } ${isDraft ? "bg-amber-500/5" : isRejected ? "bg-muted/20" : ""} ${highlighted ? "bg-primary/10" : ""}`}
    >
      {isGroupStart && (
        <span className="absolute top-2.5 left-2.5">
          <ProfileMenuTrigger
            member={authorMember}
            handleText={handleText}
            className="flex cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            ariaLabel={`Open profile for ${posterName(post)}`}
          >
            <PostAvatar post={post} size={36}/>
          </ProfileMenuTrigger>
        </span>
      )}
      {isGroupStart && (
        <div className="flex h-5 items-center gap-2 text-[13px]">
          <ProfileMenuTrigger
            member={authorMember}
            handleText={handleText}
            className="flex min-w-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            ariaLabel={`Open profile for ${posterName(post)}`}
          >
            <span className="truncate font-medium text-muted-foreground hover:underline">{posterName(post)}</span>
          </ProfileMenuTrigger>
          <PostTime post={post}/>
          {post.edited_at && !isEditing && <EditedIndicator editedAt={post.edited_at} />}
          {isPinned && (
            <span role="img" aria-label="Pinned" title="Pinned" className="shrink-0 text-muted-foreground">
              <Icon icon={PinIcon} className="size-3"/>
            </span>
          )}
          {actionsMounted && hasActions && (
            <MessageActionsBar actions={actions} leading={reactionPicker} className="ml-auto -my-0.5"/>
          )}
        </div>
      )}
      {!isGroupStart && (
        <PostTime
          post={post}
          className="invisible absolute top-1.5 left-0 w-14 text-center group-hover/row:visible"
        />
      )}
      {post.parent_preview && !isEditing && (
        <ParentQuoteBlock preview={post.parent_preview} onJump={onJumpToParent}/>
      )}
      <div className={isRejected ? "text-muted-foreground line-through" : undefined}>
        <SettleBody isStreaming={isStreaming}>{body}</SettleBody>
      </div>
      {queued && (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
          <Icon icon={Clock01Icon} className="size-3" aria-hidden />
          <span>Waiting for a reply</span>
        </div>
      )}
      {settled && post.link_preview && <LinkPreviewCard embedded={post.link_preview} />}
      {previewUrl && <LinkPreviewCard url={previewUrl} />}
      {!isEditing && !isRejected && post.files && post.files.length > 0 && (
        <MessageAttachments files={post.files} />
      )}
      {!isEditing && (
        <ReactionsStrip
          reactions={post.reactions ?? []}
          members={members}
          currentUserId={currentUserId}
          onToggle={react}
        />
      )}
      {receipt && (
        <span className="pointer-events-none absolute bottom-1 right-3">
          <span aria-label={receipt.label} className={`inline-flex shrink-0 items-center ${receipt.className}`}>
            <Icon icon={receipt.icon} className="size-3.5"/>
          </span>
        </span>
      )}
      {!isGroupStart && actionsMounted && hasActions && (
        <MessageActionsBar
          actions={actions}
          leading={reactionPicker}
          className="absolute top-0.5 right-3 z-10 rounded-md bg-background"
        />
      )}
      {hasActions && !canRightClick && (
        <MessageActionsSheet
          open={actionsSheetOpen}
          onOpenChange={setActionsSheetOpen}
          actions={actions}
          reactable={settled}
          onReact={react}
          onMore={setEmojiPicker}
        />
      )}
      {emojiPicker && (
        <ReactionEmojiPicker
          anchor={emojiPicker}
          onSelect={(emoji) => {
            burstEmojiAt(emoji, emojiPicker.x, emojiPicker.y);
            react(emoji);
            setEmojiPicker(null);
          }}
          onClose={() => { setEmojiPicker(null); }}
        />
      )}
    </div>
  );

  if (!hasActions || !canRightClick) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row}/>
      <ContextMenuContent className="min-w-52">
        {settled && (
          <>
            <div className="flex items-center gap-0.5">
              {QUICK_REACTIONS.map((e) => (
                <ContextMenuItem
                  key={e}
                  aria-label={`React with ${e}`}
                  onClick={(ev) => {
                    burstEmojiFrom(e, ev.currentTarget);
                    react(e);
                  }}
                  className="size-8 justify-center p-0 text-[18px] leading-none"
                >
                  {e}
                </ContextMenuItem>
              ))}
              <ContextMenuItem
                aria-label="More emoji"
                onClick={(ev) => { setEmojiPicker(centerOf(ev.currentTarget)); }}
                className="size-8 justify-center p-0 text-muted-foreground"
              >
                <Icon icon={SmilePlusIcon} className="size-4"/>
              </ContextMenuItem>
            </div>
            <ContextMenuSeparator/>
          </>
        )}
        {actions.map((a) => (
          <ContextMenuItem
            key={a.key}
            variant={a.key === "delete" ? "destructive" : "default"}
            onClick={a.onClick}
          >
            <Icon icon={a.icon} className="size-4"/>
            {a.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
});

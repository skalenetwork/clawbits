import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  ArrowTurnBackwardIcon,
  Clock01Icon,
  Copy01Icon,
  Delete02Icon,
  Edit02Icon,
  PinIcon,
  PinOffIcon,
  SmilePlusIcon,
  Tick02Icon,
  TickDouble02Icon,
} from "@hugeicons/core-free-icons";

import { AdminCommandGlyph } from "@/components/AdminCommandGlyph";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { Icon } from "@/components/Icon";
import { LinkPreviewCard } from "@/components/LinkPreviewCard";
import { MessageAttachments } from "@/components/MessageAttachments";
import { MessageMarkdown, type MessageMentions } from "@/components/MessageMarkdown";
import { ProfileMenuTrigger } from "@/components/ProfileMenu";
import { GeneratingIndicator } from "@/components/chat/GeneratingIndicator";
import { ToolTimelineCard } from "@/components/chat/ToolTimelineCard";
import { ThinkingTimelineCard } from "@/components/chat/ThinkingTimelineCard";
import { StreamingMarkdown } from "@/components/chat/StreamingMarkdown";
import { SettleBody } from "@/components/chat/SettleBody";
import { useSmoothedText } from "@/hooks/useSmoothedText";
import { UserAvatar } from "@/components/UserAvatar";
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
import { useBubbleMode } from "@/hooks/useBubbleMode";
import { cn } from "@/lib/utils";
import {
  memberKey,
  type ActivityMap,
  type AgentActivity,
  type PresenceMap,
  type ThinkingStep,
  type ThinkingTimelineMap,
  type ToolStep,
  type ToolTimelineMap,
} from "@/hooks/useChannelEvents";
import type {
  HumanUser,
  MmChannelMember,
  MmChannelPost,
  MmChannelType,
} from "@/lib/api";
import { matchAdminCommandText, type AdminCommandMatch } from "@/lib/adminCommands";
import { burstEmojiAt, burstEmojiFrom } from "@/lib/emojiBurst";
import { MENU_SURFACE } from "@/lib/menuSurface";
import { extractUrls } from "@/lib/extractUrls";
import { formatRelativeAgo, formatTimeOnly } from "@/lib/formatting";
import { mentionHandle, posterName } from "@/lib/messageHelpers";
import { formatReactors } from "@/lib/reactionTooltip";
import { toast } from "@/lib/toast";

function PostAvatar({
  post,
  size = 32,
  presence,
  isLatest = false,
}: {
  post: MmChannelPost;
  size?: number;
  presence?: PresenceMap;
  /** Only the latest post picks up "typing/generating" animation from
      presence — otherwise every old message from the same agent would
      animate whenever they're currently active. */
  isLatest?: boolean;
}) {
  const status = presence
    ? post.agent_id
      ? presence[memberKey("agent", post.agent_id)]
      : post.human_id != null
        ? presence[memberKey("human", post.human_id)]
        : undefined
    : undefined;
  const wrap = (child: React.ReactNode) => (
    <span className="relative inline-flex shrink-0">{child}</span>
  );
  if (post.agent_id) {
    const isActive = isLatest && (status === "typing" || status === "generating");
    return wrap(
      <AgentFaceAvatar
        size={size}
        name={post.poster_display_name ?? post.agent_id}
        src={post.avatar?.url}
        animated={post.status === "streaming" || isActive}
      />,
    );
  }
  if (post.human_id != null) {
    // ``name`` doubles as the seed for the initial-letter fallback, so
    // we prefer the display name over the raw id — "D" for Dmytro
    // reads better than "3". The glass DiceBear SVG has its own
    // background so we render at the full slot size — no inset.
    const fallbackName = post.poster_display_name ?? String(post.human_id);
    return wrap(
      <UserAvatar size={size} name={fallbackName} src={post.avatar?.url} />,
    );
  }
  return wrap(<AgentFaceAvatar size={size} name={posterName(post)} src={post.avatar?.url} />);
}


type MessageAction = {
  key: string;
  icon: typeof Copy01Icon;
  label: string;
  onClick: () => void;
};

// Slack-canonical quick reactions. Six tap-to-react options that cover the
// most common sentiments. Custom emoji come later via the full picker.
const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "😮", "😢"] as const;

/** Viewport centre of an element — used to anchor the full emoji picker (and
 *  the reaction burst) to whichever control the user just clicked. */
function centerOf(el: HTMLElement | null | undefined): { x: number; y: number } {
  const r = el?.getBoundingClientRect();
  return r
    ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/** Shared open/close + dismiss state for the quick-reaction popover.
 *  Closes on outside pointerdown, Escape, or any scroll on the page (since
 *  the popover is portaled with fixed positioning and would otherwise drift
 *  away from its trigger). */
function useReactionPicker() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // Close on background scroll (the popover is fixed-positioned and would
    // drift), but NOT when scrolling inside the popover itself — its expanded
    // emoji grid scrolls internally.
    const onScroll = (e: Event) => {
      if (popoverRef.current?.contains(e.target as Node | null)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  return { open, setOpen, triggerRef, popoverRef };
}

/** Recommended-reaction row that expands, in place, into the full "any emoji"
 *  picker. Portaled into ``document.body`` (to escape ``overflow: hidden``
 *  ancestors) and anchored to the trigger's bounding rect.
 *
 *  The recommended row stays pinned to the trigger; toggling "more" grows the
 *  full {@link EmojiGrid} *out* of that fixed edge (upward when opened above,
 *  downward when opened below), so the recommended row never jumps. The grid
 *  height is capped to the available space and scrolls internally. */
const QR_PANEL_W = 332;
function QuickReactionsPopover({
  triggerRef,
  popoverRef,
  align,
  onSelect,
}: {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  align: "left" | "right";
  onSelect: (emoji: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const tr = triggerRef.current?.getBoundingClientRect();
  if (!tr) return null;

  const GAP = 6;
  const MARGIN = 8;
  const ROW_H = 44; // approx height of the recommended row, reserved for the grid cap
  // Open on whichever side has more room, decided from the (stable) trigger so
  // it doesn't flip when expanding. Grid is capped to that side's free space.
  const spaceAbove = tr.top - GAP - MARGIN - ROW_H;
  const spaceBelow = window.innerHeight - tr.bottom - GAP - MARGIN - ROW_H;
  const openUp = spaceAbove >= spaceBelow;
  const gridH = Math.max(200, Math.min(330, openUp ? spaceAbove : spaceBelow));

  const style: React.CSSProperties = { position: "fixed", zIndex: 30 };
  if (openUp) style.bottom = window.innerHeight - tr.top + GAP;
  else style.top = tr.bottom + GAP;
  if (align === "right") style.right = Math.max(MARGIN, window.innerWidth - tr.right);
  else style.left = Math.max(MARGIN, Math.min(tr.left, window.innerWidth - QR_PANEL_W - MARGIN));
  if (expanded) style.width = QR_PANEL_W;

  const pickFull = (emoji: string) => { burstEmojiFrom(emoji, triggerRef.current); onSelect(emoji); };
  const grid = expanded ? (
    <div className="border-border/40" style={openUp ? { borderBottomWidth: 1 } : { borderTopWidth: 1 }}>
      <EmojiGrid height={gridH} onSelect={pickFull}/>
    </div>
  ) : null;

  return createPortal(
    <div
      ref={popoverRef}
      role="menu"
      aria-label="Pick a reaction"
      style={style}
      className={cn(MENU_SURFACE, "flex flex-col gap-1 p-1.5 duration-100 animate-in fade-in-0 zoom-in-95")}
    >
      {openUp && grid}
      {/* Pin the recommended row to the anchored edge so widening the panel
          (when expanding into the grid) doesn't shift it sideways. */}
      <div className={cn("flex items-center gap-0.5", align === "right" ? "justify-end" : "justify-start")}>
        {QUICK_REACTIONS.map((e) => (
          <button
            key={e}
            type="button"
            role="menuitem"
            aria-label={`React with ${e}`}
            onClick={(ev) => { burstEmojiFrom(e, ev.currentTarget); onSelect(e); }}
            className="flex size-8 items-center justify-center rounded-full text-[20px] leading-none transition-transform hover:scale-125 hover:bg-foreground/[0.06]"
          >
            {e}
          </button>
        ))}
        <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border/60"/>
        <button
          type="button"
          aria-label={expanded ? "Fewer emoji" : "More emoji"}
          aria-expanded={expanded}
          onClick={() => { setExpanded((v) => !v); }}
          className={cn(
            "flex size-8 items-center justify-center rounded-full transition-colors",
            expanded
              ? "bg-foreground/[0.08] text-foreground"
              : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
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

/** Trigger button + tiny popover with the {@link QUICK_REACTIONS} row.
 *  Lives inside the message actions bar; calls ``onSelect`` and closes. */
function ReactionQuickPickerButton({
  onSelect,
}: {
  onSelect: (emoji: string) => void;
}) {
  const { open, setOpen, triggerRef, popoverRef } = useReactionPicker();
  const pick = (emoji: string) => { onSelect(emoji); setOpen(false); };

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
              onClick={() => { setOpen((v) => !v); }}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Icon icon={SmilePlusIcon} className="size-3.5"/>
            </button>
          }
        />
        <TooltipContent side="top" sideOffset={4} className="text-xs">React</TooltipContent>
      </Tooltip>

      {open && <QuickReactionsPopover triggerRef={triggerRef} popoverRef={popoverRef} align="right" onSelect={pick}/>}
    </div>
  );
}


/** Inline message editor. Renders an autofocus textarea pre-filled with the
 *  current text plus Save/Cancel actions. Enter saves, Shift+Enter inserts
 *  a newline, Esc cancels. Save is disabled when the trimmed body is empty
 *  or unchanged from the original. */
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
  const taRef = useRef<HTMLTextAreaElement | null>(null);

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
          if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSave) onSave(trimmed);
          }
        }}
        maxLength={4000}
        spellCheck
        className="min-h-9 max-h-40 w-full resize-none border-0 bg-transparent px-3 pt-2.5 pb-1 text-[15px] leading-6 outline-none focus-visible:ring-0 [field-sizing:content]"
      />
      <div className="flex items-center gap-2 px-2.5 pt-0.5 pb-2 text-[11px] text-muted-foreground">
        <span>
          <kbd className="rounded border border-border/60 bg-muted/40 px-1 py-px font-mono text-[10px]">↵</kbd> save
          {" · "}
          <kbd className="rounded border border-border/60 bg-muted/40 px-1 py-px font-mono text-[10px]">esc</kbd> cancel
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

/** Slack-style strip of reaction pills shown below the message body.
 *  Each pill shows ``emoji count``. Clicking toggles the caller's reaction.
 *  The pill highlights when the caller themselves is among the reactors.
 *
 *  Wrapper uses the grid-template-rows trick to animate the strip's
 *  collapse / expand without measuring heights in JS: ``0fr → 1fr``
 *  transitions on the implicit row track. */
function ReactionsStrip({
  reactions,
  members,
  currentUserId,
  onToggle,
  compact = false,
  onAccent = false,
}: {
  reactions: NonNullable<MmChannelPost["reactions"]>;
  members: MmChannelMember[];
  currentUserId: number | null;
  onToggle: (emoji: string) => void;
  /** Bubble-mode variant: pills sit inline with the timestamp row (no
   *  standalone vertical rhythm / grow-collapse animation) instead of a
   *  full-width strip below the message. Pill sizing stays the same as the
   *  classic strip. */
  compact?: boolean;
  /** Rendered on a saturated accent bubble (an own message). The default
   *  foreground/muted pill tokens read as near-black on the blue fill, so
   *  switch to translucent-white tints — the count then reads white-on-accent
   *  like the timestamp beside it. */
  onAccent?: boolean;
}) {
  // The strip's grow/collapse is animated purely in CSS (grid-template-rows
  // 0fr↔1fr). Re-pinning the scroll while it grows is handled centrally by
  // MessageList's content-size observer — no per-row callback needed.
  const visible = reactions.length > 0;
  // One pill colour ramp shared by both the compact and full-width branches.
  const pillClass = (mine: boolean) =>
    onAccent
      ? mine
        ? "bg-white/25 text-white hover:bg-white/30"
        : "bg-white/10 text-white/90 hover:bg-white/20"
      : mine
        ? "bg-foreground/[0.14] text-foreground hover:bg-foreground/20"
        : "bg-muted/35 text-muted-foreground hover:bg-muted/55 hover:text-foreground";
  if (compact) {
    if (!visible) return null;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {reactions.map((r) => {
          const reactedByMe =
            currentUserId != null && r.human_ids.includes(currentUserId);
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
                    className={`flex items-center gap-2 rounded-full px-2.5 py-1.5 text-[14px] leading-none transition-[color,background-color,transform] duration-150 active:scale-[0.94] ${pillClass(reactedByMe)}`}
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
                    <span className="text-background/90">
                      {reactorLine}
                    </span>
                  </>
                ) : (
                  <span>{r.emoji}</span>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    );
  }
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
            const reactedByMe =
              currentUserId != null && r.human_ids.includes(currentUserId);
            const reactorLine = formatReactors(r, members, currentUserId);
            return (
              <Tooltip key={r.emoji}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={(e) => {
                        // Spray the emoji up out of the chip — but only when
                        // adding, not when toggling our own reaction back off.
                        if (!reactedByMe) burstEmojiFrom(r.emoji, e.currentTarget);
                        onToggle(r.emoji);
                      }}
                      className={`flex items-center gap-2 rounded-full px-2.5 py-1.5 text-[14px] leading-none transition-[color,background-color,transform] duration-150 active:scale-[0.94] ${pillClass(reactedByMe)}`}
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
                      <span className="text-background/90">
                        {reactorLine}
                      </span>
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

/** Pencil affordance marking an edited message. Icon-only by request — the
 *  edit time lives in the tooltip. Colour is inherited from the parent so it
 *  reads white on an own accent bubble and muted elsewhere; pass ``className``
 *  when a caller needs an explicit tone (e.g. the classic layout). */
function EditedIndicator({
  editedAt,
  className,
}: {
  editedAt: string;
  className?: string;
}) {
  const ago = formatRelativeAgo(editedAt);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex shrink-0 cursor-default items-center align-middle opacity-80",
              className,
            )}
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

/** Slack-style floating action pill — one rounded container, all message
 *  actions inline. ``leading`` slots in custom content (e.g. the reaction
 *  picker) before the standard action icons. Hover-only at row level. */
function MessageActionsBar({
  actions,
  leading,
}: {
  actions: MessageAction[];
  leading?: ReactNode;
}) {
  if (actions.length === 0 && !leading) return null;
  return (
    <div
      className="absolute -top-3 right-3 z-10 flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/95 p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover/row:opacity-100"
      role="toolbar"
      aria-label="Message actions"
    >
      {leading}
      {actions.map((a) => (
        <Tooltip key={a.key}>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={a.onClick}
                aria-label={a.label}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
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

/** Touch action sheet — the mobile counterpart to the hover-only
 *  {@link MessageActionsBar}. Opened by a long-press on the row; surfaces the
 *  quick-reaction row plus the same reply/edit/pin/copy/delete actions as
 *  rows, so touch users can finally act on a message. */
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
  onMore?: (anchor: { x: number; y: number }) => void;
}) {
  // Close first, then run the action — so a Reply/Edit that focuses the
  // composer isn't fighting the drawer's closing focus trap.
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
                  // Fire from the tapped emoji before the sheet animates away.
                  burstEmojiFrom(e, ev.currentTarget);
                  run(() => {
                    onReact(e);
                  });
                }}
                className="flex size-12 items-center justify-center rounded-full text-[26px] leading-none transition active:scale-90 active:bg-foreground/10"
              >
                {e}
              </button>
            ))}
            {onMore && (
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
            )}
          </div>
        )}
        <div className="flex flex-col pb-2">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => {
                run(a.onClick);
              }}
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

/** Inline quote-block rendered above a reply's body. Shows the parent's
 *  author + a truncated excerpt; clicking jumps to the parent message.
 *  If the parent was rejected, fades the body and labels it as removed. */
function ParentQuoteBlock({
  preview,
  onJump,
}: {
  preview: NonNullable<MmChannelPost["parent_preview"]>;
  onJump: (postId: number) => void;
}) {
  const removed = preview.status === "rejected";
  const authorName =
    preview.poster_display_name
    ?? preview.agent_id
    ?? (preview.human_id != null ? `User ${String(preview.human_id)}` : "Unknown");
  return (
    <button
      type="button"
      onClick={() => { onJump(preview.post_id); }}
      className="mt-1 mb-1 flex w-full max-w-[28rem] items-stretch gap-2 rounded-md bg-muted/35 py-1 pl-2.5 pr-2.5 text-left transition-colors hover:bg-muted/55"
      aria-label={`Jump to message from ${authorName}`}
    >
      <span aria-hidden className="w-0.5 shrink-0 rounded-full bg-primary/60"/>
      <span className="min-w-0 flex-1 leading-snug">
        {removed ? (
          <span className="block truncate text-[12px] italic text-muted-foreground">
            Original message removed
          </span>
        ) : (
          <>
            <span className="block truncate text-[12px] font-medium text-foreground/85">{authorName}</span>
            <span className="block truncate text-[12px] text-muted-foreground">
              {preview.message_excerpt || "(empty message)"}
            </span>
          </>
        )}
      </span>
    </button>
  );
}

function DraftBody({
  text,
  mentions,
  activity,
  toolSteps,
  thinkingSteps,
  agentId,
}: {
  text: string;
  mentions?: MessageMentions;
  activity?: AgentActivity | null;
  toolSteps?: ToolStep[];
  thinkingSteps?: ThinkingStep[];
  agentId?: string;
}) {
  // Drafts are actively being streamed. Meter the coalesced target text onto
  // the screen a few characters per frame (useSmoothedText) so a bursty stream
  // reads as a smooth typewriter rather than landing in chunks. DraftBody is
  // mounted only while the post is streaming, so metering is always on here.
  const smoothed = useSmoothedText(text, true);
  const hasTools = (toolSteps?.length ?? 0) > 0;
  const hasThinking = (thinkingSteps?.length ?? 0) > 0;
  // Empty draft → the shared {@link GeneratingIndicator} (its own animated
  // panel). Match the outer sizing of MessageMarkdown so the indicator sits
  // where a finished reply would and the presence-row → streaming-post handoff
  // is seamless.
  if (!smoothed) {
    return (
      <div className="text-[15px] leading-relaxed text-muted-foreground">
        <GeneratingIndicator
          activity={activity}
          toolSteps={toolSteps}
          thinkingSteps={thinkingSteps}
          agentId={agentId}
        />
      </div>
    );
  }
  // Growing body: block-memoized markdown with a word-by-word blur-in tail + an
  // inline caret (StreamingMarkdown), then the minimal reasoning + tool footers
  // at the END (Claude-Code style — footnotes, not headers). The answer is now
  // streaming, so the reasoning is over → the thinking card renders ``sealed``.
  return (
    <div>
      <StreamingMarkdown text={smoothed} mentions={mentions} />
      {hasThinking && thinkingSteps && <ThinkingTimelineCard steps={thinkingSteps} sealed />}
      {hasTools && toolSteps && <ToolTimelineCard steps={toolSteps} />}
    </div>
  );
}

function AdminCommandBody({ command }: { command: AdminCommandMatch }) {
  return (
    <div className="my-1 inline-flex max-w-full items-center gap-2 rounded-full border border-border/60 bg-muted/60 px-2.5 py-1 text-foreground/80">
      <AdminCommandGlyph kind={command.kind} className="size-5" />
      <code className="min-w-0 shrink-0 truncate font-mono text-[13px] font-semibold leading-none tracking-tight text-foreground">
        {command.command}
      </code>
      <span aria-hidden className="hidden size-0.5 shrink-0 rounded-full bg-muted-foreground/60 sm:block"/>
      <span className="hidden min-w-0 truncate text-[12px] font-medium leading-none text-muted-foreground sm:inline">
        {command.description}
      </span>
    </div>
  );
}

type ReceiptState = "sending" | "delivered" | "read";

/** Telegram-style outgoing-message indicator. Single check = delivered
 *  (server-published but peer hasn't read), double check (tinted) = peer
 *  has caught up to this post, clock = optimistic/streaming. */
function ReadReceiptIndicator({
  state,
  onAccent = false,
}: {
  state: ReceiptState;
  /** Rendered on the accent-filled own bubble (bubble mode) — the default
   *  muted/sky tints wash out on the blue fill, so switch to white tints that
   *  match the bubble's timestamp text. */
  onAccent?: boolean;
}) {
  const { icon, label, className } = state === "read"
    ? {
        icon: TickDouble02Icon,
        label: "Read",
        className: onAccent ? "text-white" : "text-sky-500 dark:text-sky-400",
      }
    : state === "delivered"
      ? {
          icon: Tick02Icon,
          label: "Delivered",
          className: onAccent ? "text-white/75" : "text-muted-foreground/80",
        }
      : {
          icon: Clock01Icon,
          label: "Sending",
          className: onAccent ? "text-white/60" : "text-muted-foreground/60",
        };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className={`inline-flex shrink-0 items-center ${className}`}
          >
            <Icon icon={icon} className="size-3.5"/>
          </span>
        }
      />
      <TooltipContent side="top" sideOffset={4} className="text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Compute the receipt state for a post. Returns null when no indicator
 *  should render (group channel, incoming post, non-author own post,
 *  rejected/draft, etc.). */
function computeReceiptState(
  post: MmChannelPost,
  channelType: MmChannelType | undefined,
  currentUser: HumanUser | null,
  members: MmChannelMember[],
): ReceiptState | null {
  if (channelType !== "direct") return null;
  if (!currentUser) return null;
  if (post.human_id !== currentUser.id || post.agent_id != null) return null;
  if (post.status === "draft" || post.status === "rejected") return null;
  // Optimistic insert (negative id) or token stream → still in flight.
  if (post.post_id < 0 || post.status === "streaming") return "sending";
  if (post.status !== "published") return null;
  // Find the DM peer (any other human in the members list). Agents are
  // ignored — they never advance a read pointer.
  let peerLastRead: number | null = null;
  for (const m of members) {
    if (m.human_id != null && m.human_id !== currentUser.id) {
      peerLastRead = m.last_read_post_id ?? null;
      break;
    }
  }
  if (peerLastRead != null && peerLastRead >= post.post_id) return "read";
  return "delivered";
}

export interface MessageRowProps {
  post: MmChannelPost;
  currentUser: HumanUser | null;
  /** True when the current human created this channel — gates the
   *  "delete anyone's message" moderation action on top of the
   *  per-message author check. */
  isChannelCreator: boolean;
  isGroupStart: boolean;
  /** Last post of a same-author run. In bubble mode the avatar (group chats)
   *  anchors to this row, Telegram-style. */
  isGroupEnd?: boolean;
  isLatest: boolean;
  presence: PresenceMap;
  /** Live per-agent activity (same "agent:<id>" keys as ``presence``);
   *  feeds the empty streaming draft's indicator label. */
  activity?: ActivityMap;
  /** Ordered per-agent tool timeline for the current turn (same keys as
   *  ``activity``); feeds the streaming draft's tool-timeline card. */
  toolTimelines?: ToolTimelineMap;
  /** Ordered per-agent reasoning timeline for the current turn (same keys as
   *  ``activity``); feeds the streaming draft's thinking-timeline card. */
  thinkingTimelines?: ThinkingTimelineMap;
  /** Finished per-post tool traces (post_id → steps) — renders the collapsed,
   *  unfoldable tool-timeline card on a published agent reply. */
  finishedToolTraces?: Record<number, ToolStep[]>;
  /** Finished per-post reasoning traces (post_id → segments) — renders the
   *  collapsed, unfoldable thinking-timeline card on a published agent reply. */
  finishedThinkingTraces?: Record<number, ThinkingStep[]>;
  mentions?: MessageMentions;
  members: MmChannelMember[];
  /** Channel kind — DM-only feature gate for read receipts. */
  channelType: MmChannelType | undefined;
  onReply: (post: MmChannelPost) => void;
  onJumpToParent: (postId: number) => void;
  onToggleReaction: (postId: number, emoji: string) => void;
  onTogglePin: (post: MmChannelPost) => void;
  isEditing: boolean;
  onStartEdit: (post: MmChannelPost) => void;
  onSaveEdit: (postId: number, message: string) => void;
  onCancelEdit: () => void;
  editSaving: boolean;
  onDelete: (post: MmChannelPost) => void;
  highlighted: boolean;
  /** This is one of the current user's own messages that was sent while an
   *  agent is already mid-reply and hasn't been answered yet — render a quiet
   *  "waiting for a reply" marker so the pile-up is acknowledged. Derived in
   *  ChannelPage; only ever true for the user's own unanswered messages. */
  queued?: boolean;
}

/** A single message row in the chat timeline. Switches between three
 *  visual modes:
 *
 *  - Grouped continuation (``!isGroupStart``): no avatar, no author chip,
 *    timestamp surfaces only on hover. Reads as a continuation of the
 *    previous row.
 *  - Group start: avatar + author + timestamp on the header line.
 *  - Editing: avatar + author header are kept, but the body is
 *    replaced with the inline editor.
 *
 *  The row body composes the markdown body, parent-quote, link preview
 *  (embedded server-side or async client fetch), attachments, reactions
 *  strip, and (for drafts) the approval bar. Hover surfaces the action
 *  pill (react / reply / edit / pin / copy / delete).
 *
 *  All cross-row side effects are forwarded as callbacks — this
 *  component itself owns no mutation state; it's safe to memo by
 *  reference identity of ``post`` + the relevant boolean props. */
export function MessageRow({
  post,
  currentUser,
  isChannelCreator,
  isGroupStart,
  isGroupEnd = true,
  isLatest,
  presence,
  activity,
  toolTimelines,
  thinkingTimelines,
  finishedToolTraces,
  finishedThinkingTraces,
  mentions,
  members,
  channelType,
  onReply,
  onJumpToParent,
  onToggleReaction,
  onTogglePin,
  isEditing,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  editSaving,
  onDelete,
  highlighted,
  queued = false,
}: MessageRowProps) {
  const isStreaming = post.status === "streaming";
  // The streaming → published settle (height morph + fade) is owned by
  // {@link SettleBody}, which wraps the body below and detects that edge itself.
  const isDraft = post.status === "draft";
  const isRejected = post.status === "rejected";
  const bubbleMode = useBubbleMode();
  // Bubble layout applies to normal/streaming/rejected posts. Editing keeps the
  // full-width inline editor, and drafts keep the classic approval affordances —
  // both would be cramped inside a bubble.
  const useBubble = bubbleMode && !isEditing && !isDraft;
  const canAct = !isStreaming && !isDraft;
  const canReply = canAct && !isRejected;
  const isOwnHumanPost = Boolean(
    currentUser && post.human_id === currentUser.id && post.agent_id == null,
  );
  const canEdit = isOwnHumanPost && post.status === "published";
  // Author can delete their own published post; channel creator can
  // delete anyone's post for moderation. Streaming and draft rows are
  // intentionally excluded — they're transient or pre-publication and
  // already churn on their own.
  const canDelete = (isOwnHumanPost || isChannelCreator)
    && (post.status === "published" || post.status === "rejected");
  const parentPreview = post.parent_preview ?? null;
  // An edited post gets a small pencil affordance (see EditedIndicator)
  // rather than an inline "(edited)" string: the old CSS ::after couldn't
  // carry a tooltip and, being a pseudo-element, slipped past the own-bubble
  // ``!text-white`` override to render muted-grey on the blue fill.
  const isEdited = Boolean(post.edited_at) && !isEditing;
  const isAgentDirect = channelType === "direct" && members.some((m) => m.agent_id != null);
  const adminCommand = isOwnHumanPost && isAgentDirect
    ? matchAdminCommandText(post.message)
    : null;
  // Tool + reasoning traces snapshotted onto this finished reply — rendered as
  // quiet footers under the answer (collapsed, unfoldable), mirroring where the
  // streaming DraftBody showed them so the finalize handoff stays seamless.
  const finishedTools = !isStreaming && post.agent_id
    ? finishedToolTraces?.[post.post_id]
    : undefined;
  const finishedThinking = !isStreaming && post.agent_id
    ? finishedThinkingTraces?.[post.post_id]
    : undefined;
  const messageBody = isStreaming
    ? (
        <DraftBody
          text={post.message}
          mentions={mentions}
          agentId={post.agent_id ?? undefined}
          activity={
            post.agent_id ? activity?.[memberKey("agent", post.agent_id)] : undefined
          }
          toolSteps={
            post.agent_id ? toolTimelines?.[memberKey("agent", post.agent_id)] : undefined
          }
          thinkingSteps={
            post.agent_id ? thinkingTimelines?.[memberKey("agent", post.agent_id)] : undefined
          }
        />
      )
    : isEditing
      ? (
          <InlineMessageEditor
            initialText={post.message}
            saving={editSaving}
            onSave={(next) => { onSaveEdit(post.post_id, next); }}
            onCancel={onCancelEdit}
          />
        )
      : adminCommand
        ? <AdminCommandBody command={adminCommand}/>
        : (
            <>
              <MessageMarkdown content={post.message} mentions={mentions}/>
              {finishedThinking && finishedThinking.length > 0 && (
                <ThinkingTimelineCard steps={finishedThinking} sealed />
              )}
              {finishedTools && finishedTools.length > 0 && (
                <ToolTimelineCard steps={finishedTools} />
              )}
            </>
          );
  const reactions = post.reactions ?? [];

  // Full "any emoji" reaction picker — opened (anchored to a viewport point)
  // from the quick-reaction rows / context-menu "+", shared across every entry
  // point so there's one picker to position and dismiss.
  const [emojiPicker, setEmojiPicker] = useState<{ x: number; y: number } | null>(null);
  const reactAndBurst = (emoji: string, x: number, y: number) => {
    burstEmojiAt(emoji, x, y);
    onToggleReaction(post.post_id, emoji);
  };

  // Right-click menu is for pointer devices only. On touch, a long-press fires
  // a native `contextmenu` too, which would open this menu on top of the
  // long-press action sheet — so gate it to fine pointers and leave touch to
  // the sheet.
  const canRightClick = useMemo(
    () => typeof window !== "undefined" && (window.matchMedia?.("(pointer: fine)").matches ?? false),
    [],
  );

  // Skip unfurls on transient post states — for streaming/draft the
  // message body still mutates, and for rejected/editing rows a card
  // would just be visual noise. Render at most one preview per post:
  // server resolves the first URL on publish/edit and embeds it
  // (``post.link_preview``); for legacy rows the client falls back to
  // its async fetcher on the first extracted URL.
  const showPreview = !isStreaming && !isDraft && !isRejected && !isEditing;
  const embeddedPreview = showPreview ? post.link_preview ?? null : null;
  const fallbackPreviewUrl = showPreview && !embeddedPreview
    ? extractUrls(post.message)[0] ?? null
    : null;
  // Body composed from independent pieces so the classic and bubble layouts
  // can arrange them differently (bubbles keep quote + text inside the pill but
  // float previews/attachments/reactions below it, aligned to the bubble side).
  const quoteBlock = parentPreview && !isEditing
    ? <ParentQuoteBlock preview={parentPreview} onJump={onJumpToParent}/>
    : null;
  const bodyText = (
    <div className={isRejected ? "text-muted-foreground line-through" : undefined}>
      <SettleBody isStreaming={isStreaming}>{messageBody}</SettleBody>
    </div>
  );
  const queuedMarker = queued ? (
    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
      <Icon icon={Clock01Icon} className="size-3" aria-hidden />
      <span>Waiting for a reply</span>
    </div>
  ) : null;
  const previewCards = (
    <>
      {embeddedPreview && <LinkPreviewCard embedded={embeddedPreview} />}
      {!embeddedPreview && fallbackPreviewUrl && <LinkPreviewCard url={fallbackPreviewUrl} />}
    </>
  );
  const attachmentsBlock = !isEditing && !isRejected && post.files && post.files.length > 0
    ? <MessageAttachments files={post.files} />
    : null;
  const reactionsBlock = !isEditing ? (
    <ReactionsStrip
      reactions={reactions}
      members={members}
      currentUserId={currentUser?.id ?? null}
      onToggle={(emoji) => { onToggleReaction(post.post_id, emoji); }}
    />
  ) : null;
  const body = (
    <>
      {quoteBlock}
      {bodyText}
      {isEdited && (
        <div className="mt-0.5 flex">
          <EditedIndicator editedAt={post.edited_at ?? ""} className="text-muted-foreground/70" />
        </div>
      )}
      {queuedMarker}
      {previewCards}
      {attachmentsBlock}
      {reactionsBlock}
    </>
  );
  // The reaction picker lives in ``leading`` since it owns its own popover.
  // Edit is rendered only when the caller authored the post and it's
  // currently published (Slack-style — no edits on drafts/rejected).
  const isPinned = post.pinned_at != null;
  const canPin = post.status === "published";

  // Resolve the channel-member behind this post so the avatar/name can
  // anchor the ProfileMenu. Falls back to a synthetic member built from
  // the post fields when the channel-members payload doesn't list this
  // poster (e.g. they've left the channel). All trigger props on the
  // resulting button are stable references, so the memoized
  // ProfileMenuTrigger doesn't re-render across normal parent renders.
  const authorMember: MmChannelMember | null = useMemo(() => {
    const found = members.find((m) =>
      post.agent_id != null
        ? m.agent_id === post.agent_id
        : post.human_id != null
          ? m.human_id === post.human_id
          : false,
    );
    if (found) return found;
    if (post.agent_id == null && post.human_id == null) return null;
    return {
      agent_id: post.agent_id ?? null,
      human_id: post.human_id ?? null,
      display_name: post.poster_display_name ?? null,
      joined_at: post.created_at,
      status: null,
      last_seen_at: null,
      avatar: post.avatar ?? null,
    };
  }, [members, post.agent_id, post.human_id, post.poster_display_name, post.created_at, post.avatar]);
  const authorHandle = authorMember ? `@${mentionHandle(authorMember)}` : "@user";

  const actions: MessageAction[] = (canAct && !isEditing)
    ? [
        ...(canReply
          ? [{
              key: "reply",
              icon: ArrowTurnBackwardIcon,
              label: "Reply",
              onClick: () => { onReply(post); },
            }]
          : []),
        ...(canEdit
          ? [{
              key: "edit",
              icon: Edit02Icon,
              label: "Edit",
              onClick: () => { onStartEdit(post); },
            }]
          : []),
        ...(canPin
          ? [{
              key: "pin",
              icon: isPinned ? PinOffIcon : PinIcon,
              label: isPinned ? "Unpin from channel" : "Pin to channel",
              onClick: () => { onTogglePin(post); },
            }]
          : []),
        {
          key: "copy",
          icon: Copy01Icon,
          label: "Copy",
          onClick: () => {
            navigator.clipboard.writeText(post.message).then(
              () => { toast.success("Copied"); },
              () => { toast.error("Copy failed"); },
            );
          },
        },
        ...(canDelete
          ? [{
              key: "delete",
              icon: Delete02Icon,
              label: "Delete",
              onClick: () => { onDelete(post); },
            }]
          : []),
      ]
    : [];
  const reactionLeading = canReply && !isEditing ? (
    <ReactionQuickPickerButton
      onSelect={(emoji) => { onToggleReaction(post.post_id, emoji); }}
    />
  ) : undefined;
  const draftBg = isDraft ? "bg-amber-500/5" : isRejected ? "bg-muted/20" : "";
  // Soft jump-to-parent flash — primary tint that fades back to nothing.
  // Lower visual weight than a hard ring; matches the taste guide's
  // "flat with subtle depth" stance.
  const highlightCls = highlighted ? "bg-primary/10" : "";
  // "Pinned" label shown *above* a pinned message — the Slack/Discord pattern.
  // A quiet muted metadata line (not a saturated amber glyph crowding the
  // text) that still lets readers spot a pinned message at a glance while
  // scrolling. Rendered at each call site aligned with the message content:
  // above the author header for a group start, above the body for a
  // continuation.
  const pinnedLabel = isPinned ? (
    <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground/80">
      <Icon icon={PinIcon} className="size-3 shrink-0" />
      <span>Pinned</span>
    </div>
  ) : null;
  const receiptState = computeReceiptState(post, channelType, currentUser, members);
  const receiptIndicator = receiptState ? <ReadReceiptIndicator state={receiptState}/> : null;

  // Touch: long-press opens the action sheet (the hover bar is mouse-only, so
  // without this there's no way to react/reply/delete on a phone). Gated on
  // there being something to show; the hook ignores mouse/pen pointers.
  const [actionsSheetOpen, setActionsSheetOpen] = useState(false);
  const hasRowActions = actions.length > 0 || reactionLeading != null;
  const longPress = useLongPress(() => {
    if (hasRowActions) setActionsSheetOpen(true);
  });
  const actionsSheet = hasRowActions ? (
    <MessageActionsSheet
      open={actionsSheetOpen}
      onOpenChange={setActionsSheetOpen}
      actions={actions}
      reactable={canReply && !isEditing}
      onReact={(emoji) => {
        onToggleReaction(post.post_id, emoji);
      }}
      onMore={(anchor) => { setEmojiPicker(anchor); }}
    />
  ) : null;

  // Right-click context menu: a quick-reaction row (+ "any emoji") atop the
  // same actions the hover bar exposes. Rendered only when the row actually has
  // actions; otherwise the row keeps the browser's native menu.
  const canQuickReact = canReply && !isEditing;
  const contextMenu = hasRowActions ? (
    <ContextMenuContent className="min-w-52">
      {canQuickReact && (
        <>
          <div className="flex items-center gap-0.5 px-1 pt-0.5 pb-1">
            {QUICK_REACTIONS.map((e) => (
              <ContextMenuItem
                key={e}
                aria-label={`React with ${e}`}
                onClick={(ev) => {
                  burstEmojiFrom(e, ev.currentTarget as HTMLElement);
                  onToggleReaction(post.post_id, e);
                }}
                className="size-9 justify-center p-0 text-[20px] leading-none transition-transform hover:scale-110"
              >
                {e}
              </ContextMenuItem>
            ))}
            <ContextMenuItem
              aria-label="More emoji"
              onClick={(ev) => { setEmojiPicker(centerOf(ev.currentTarget as HTMLElement)); }}
              className="size-9 justify-center p-0 text-muted-foreground"
            >
              <Icon icon={SmilePlusIcon} className="size-[18px]"/>
            </ContextMenuItem>
          </div>
          {actions.length > 0 && <ContextMenuSeparator/>}
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
  ) : null;

  // Portaled overlays shared by both row layouts: the touch action sheet and
  // the full emoji picker (anchored to wherever it was opened from).
  const overlays = (
    <>
      {actionsSheet}
      {emojiPicker && (
        <ReactionEmojiPicker
          anchor={emojiPicker}
          onSelect={(emoji) => {
            reactAndBurst(emoji, emojiPicker.x, emojiPicker.y);
            setEmojiPicker(null);
          }}
          onClose={() => { setEmojiPicker(null); }}
        />
      )}
    </>
  );

  // Wrap a row element in the right-click menu when there's one to show.
  const withContextMenu = (row: React.ReactElement) =>
    contextMenu && canRightClick ? (
      <ContextMenu>
        <ContextMenuTrigger render={row}/>
        {contextMenu}
      </ContextMenu>
    ) : row;

  // ── Bubble layout ──────────────────────────────────────────────────────
  // iMessage/Telegram-style speech bubbles. Own messages hug the right with an
  // accent fill and no avatar. Everyone else's hug the left with a neutral fill
  // and a per-author colored name (on a group start). In group chats (anything
  // but a 1:1 DM) the sender's avatar rides at the bottom-left of the run,
  // anchored to the last message — the Telegram idiom.
  if (useBubble) {
    const own = isOwnHumanPost;
    // Name + avatar are group-chat affordances only. A 1:1 DM has a single
    // counterpart (already named in the header), so its bubbles stay clean —
    // no per-message name or avatar, matching Telegram's DM style.
    const isGroupChat = channelType !== "direct";
    const showName = isGroupStart && !own && isGroupChat;
    const showAvatars = !own && isGroupChat;
    const time = formatTimeOnly(post.created_at);
    // Trailing meta (reactions + timestamp + read receipt). It normally rides
    // INSIDE the text bubble (``onAccent`` = own-blue tints); an attachment-only
    // message renders no bubble, so the same row is shown BELOW the media with
    // muted, non-accent tints (it sits on the page background, not the fill).
    const metaRow = (onAccent: boolean) => (
      <div className="mt-1 flex w-full items-center justify-between gap-2">
        {/* useBubble already excludes the editing state, so reactions always show. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <ReactionsStrip
            reactions={reactions}
            members={members}
            currentUserId={currentUser?.id ?? null}
            onToggle={(emoji) => { onToggleReaction(post.post_id, emoji); }}
            compact
            onAccent={onAccent}
          />
        </div>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 text-[10px] tabular-nums",
            onAccent ? "text-white/70" : "text-muted-foreground",
          )}
        >
          {isEdited && <EditedIndicator editedAt={post.edited_at ?? ""} />}
          {time}
          {own && receiptState && <ReadReceiptIndicator state={receiptState} onAccent={onAccent} />}
        </span>
      </div>
    );
    // Does the message carry media (attachments or a link-preview card)? It
    // renders in a DEFINITE-width wrapper below: in bubble mode the content
    // column is shrink-to-fit (items-start/end), where MessageAttachments' images
    // size with percentage widths that would otherwise collapse to 0.
    const hasMedia =
      attachmentsBlock !== null || embeddedPreview !== null || fallbackPreviewUrl !== null;
    // Whether the text bubble has anything worth a pill. An attachment-only
    // message (no text / quote / footers) skips the empty bubble and lets the
    // media BE the message. Streaming posts always keep it (DraftBody owns their
    // content, incl. the empty-draft generating indicator).
    const hasBubbleBody =
      isStreaming ||
      post.message.trim().length > 0 ||
      quoteBlock !== null ||
      queued ||
      (finishedThinking != null && finishedThinking.length > 0) ||
      (finishedTools != null && finishedTools.length > 0);
    const bubble = (
      <div
        className={cn(
          "relative flex min-w-0 max-w-full flex-col rounded-2xl px-3 py-2 text-[15px] leading-relaxed",
          own
            ? "rounded-br-md bg-[#2f6bf6] text-white [&_a]:text-white [&_a]:underline"
            : "rounded-bl-md bg-black/[0.055] text-foreground dark:bg-white/[0.09]",
          isRejected && "opacity-70",
        )}
      >
        {showName && (
          <span className="mb-0.5 truncate text-[13px] font-semibold text-muted-foreground">
            {posterName(post)}
          </span>
        )}
        {/* Own bubbles paint on a fixed accent fill, so their body must read as
            white in BOTH themes — override MessageMarkdown's ``text-foreground``
            root and the ``text-mention`` tint (both otherwise flip dark in light
            mode and wash out on the accent). Scoped to the body group so the
            colored author name and the meta line keep their own colors. */}
        <div
          className={cn(
            "min-w-0",
            // Own bubbles paint on a fixed blue fill, so force the body white
            // in both themes. Code surfaces then need a dark inset — otherwise
            // the muted/light fill washes out over blue and the forced-white
            // code/inline-code has nothing to read against.
            own &&
              "[&_*]:!text-white [&_.code-block]:!bg-black/25 [&_.code-block]:!ring-white/15 [&_.inline-code]:!bg-black/25",
          )}
        >
          {quoteBlock}
          {bodyText}
          {queuedMarker}
        </div>
        {/* Trailing meta row, on the accent fill inside the bubble. */}
        {metaRow(own)}
      </div>
    );
    return withContextMenu(
      <div
        data-post-id={post.post_id}
        {...longPress}
        className={cn(
          "group/row relative mx-0.5 flex min-w-0 items-end gap-2 px-2",
          isGroupStart ? "mt-3" : "mt-0.5",
          own ? "justify-end" : "justify-start",
          draftBg,
          highlightCls,
        )}
      >
        {/* Avatar gutter — reserved for every row in a run so bubbles stay
            aligned, but only the group's last row actually paints the avatar
            (it hugs the bottom via the row's ``items-end``). */}
        {showAvatars && (
          <div className="w-7 shrink-0 self-end">
            {isGroupEnd && (
              <ProfileMenuTrigger
                member={authorMember}
                handleText={authorHandle}
                className="block cursor-pointer rounded-full outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring/40"
                ariaLabel={`Open profile for ${posterName(post)}`}
              >
                <PostAvatar post={post} size={28} presence={presence} isLatest={isLatest} />
              </ProfileMenuTrigger>
            )}
          </div>
        )}
        <div
          className={cn(
            "flex min-w-0 max-w-[80%] flex-col gap-1",
            own ? "items-end" : "items-start",
          )}
        >
          {pinnedLabel}
          {/* Suppress the empty text pill for an attachment-only message; keep it
              otherwise (incl. weird no-media/no-text edges, so nothing vanishes). */}
          {(hasBubbleBody || !hasMedia) && bubble}
          {hasMedia && (
            <div className="flex w-80 max-w-full flex-col">
              {/* Attachment-only: the media IS the message, so carry the group
                  sender name above it and the meta row below — there's no bubble
                  to hold them. Captioned media keeps both in the bubble instead. */}
              {!hasBubbleBody && showName && (
                <span className="mb-0.5 truncate text-[13px] font-semibold text-muted-foreground">
                  {posterName(post)}
                </span>
              )}
              {previewCards}
              {attachmentsBlock}
              {!hasBubbleBody && metaRow(false)}
            </div>
          )}
        </div>
        {/* No hover action bar in bubble mode — it crowded the bubbles. React /
            reply / pin / etc. stay reachable via right-click (desktop) and
            long-press (touch); ``overlays`` carries those sheets + pickers. */}
        {overlays}
      </div>,
    );
  }

  if (!isGroupStart) {
    return withContextMenu(
      <div
        data-post-id={post.post_id}
        {...longPress}
        className={`group/row relative mx-0.5 min-w-0 rounded-lg py-0.5 pl-[60px] pr-3 transition-colors duration-500 hover:bg-muted/15 has-[a[data-link-preview]:hover]:bg-transparent ${draftBg} ${highlightCls}`}
      >
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100">
          {formatTimeOnly(post.created_at)}
        </span>
        {pinnedLabel}
        {body}
        {receiptIndicator && (
          <span className="pointer-events-none absolute bottom-1 right-3">
            {receiptIndicator}
          </span>
        )}
        <MessageActionsBar actions={actions} leading={reactionLeading}/>
        {overlays}
      </div>
    );
  }
  return withContextMenu(
    <div
      data-post-id={post.post_id}
      {...longPress}
      className={`group/row relative mx-0.5 mt-4 flex items-start gap-3 rounded-lg pl-2 pr-3 pt-1.5 pb-0.5 transition-colors duration-500 hover:bg-muted/15 has-[a[data-link-preview]:hover]:bg-transparent ${draftBg} ${highlightCls}`}
    >
      <ProfileMenuTrigger
        member={authorMember}
        handleText={authorHandle}
        className="mt-0.5 shrink-0 cursor-pointer rounded-full outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring/40"
        ariaLabel={`Open profile for ${posterName(post)}`}
      >
        <PostAvatar post={post} size={34} presence={presence} isLatest={isLatest}/>
      </ProfileMenuTrigger>
      <div className="min-w-0 flex-1">
        {pinnedLabel}
        <div className="flex items-baseline gap-2">
          <ProfileMenuTrigger
            member={authorMember}
            handleText={authorHandle}
            className="truncate cursor-pointer rounded text-sm font-semibold tracking-tight outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
            ariaLabel={`Open profile for ${posterName(post)}`}
          >
            {posterName(post)}
          </ProfileMenuTrigger>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{formatTimeOnly(post.created_at)}</span>
        </div>
        {body}
      </div>
      {receiptIndicator && (
        <span className="pointer-events-none absolute bottom-1 right-3">
          {receiptIndicator}
        </span>
      )}
      <MessageActionsBar actions={actions} leading={reactionLeading}/>
      {overlays}
    </div>
  );
}

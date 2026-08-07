import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AttachmentIcon,
  ArrowDown02Icon,
  ArrowUp02Icon,
  BotIcon,
  Cancel01Icon,
  Robot02Icon,
  UserIcon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { AdminCommandGlyph } from "@/components/AdminCommandGlyph";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { AttachmentChip } from "@/components/AttachmentChip";
import { ChannelGlyph } from "@/components/ChannelGlyph";
import { EmojiPickerButton } from "@/components/EmojiPicker";
import { Icon } from "@/components/Icon";
import type { MessageMentions } from "@/components/MessageMarkdown";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/UserAvatar";
import {
  extractAdminCommandQuery,
  getAdminCommandOptions,
  type AdminCommandCategory,
  type AdminCommandDefinition,
} from "@/lib/adminCommands";
import { extractClipboardFiles } from "@/lib/clipboardFiles";
import { isDesktop } from "@/lib/desktop";
import { isHereToken } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import type { MmChannel, MmChannelMember, MmChannelPost } from "@/lib/api";
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
  let match: RegExpExecArray | null;
  COMPOSER_MENTION_RE.lastIndex = 0;
  while ((match = COMPOSER_MENTION_RE.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index));
    const raw = match[0];
    const token = raw.slice(1).toLowerCase();
    let resolved: boolean;
    if (raw.startsWith("#")) {
      resolved = mentions.channelsByToken?.has(token) ?? false;
    } else {
      const isPrimaryAgent =
        mentions.primaryAgentToken && token === mentions.primaryAgentToken.toLowerCase();
      const isAgent = mentions.agentTokens.has(token);
      const isHuman = mentions.humanTokens.has(token);
      resolved = isHereToken(token) || Boolean(isPrimaryAgent || isAgent || isHuman);
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

// ----------------------------------------------------------------------------
// Mention + emoji-shortcode popovers. Pulled out so the keyboard handler in
// the main component stays compact.
// ----------------------------------------------------------------------------

// Shared chrome for the four composer autocomplete popovers (slash / mention /
// channel / emoji): one frosted panel anchored above the composer that scales
// up on open (matching the app's other popovers). Header + footer are slots so
// each popover keeps its own contents. React keeps this element mounted while a
// popover stays open, so the entrance animation plays once, not per keystroke.
function ComposerPopoverFrame({
  header,
  footer,
  children,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="absolute bottom-full left-10 right-12 mb-2 origin-bottom overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-md backdrop-blur-xl duration-150 ease-out animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1 supports-[backdrop-filter]:bg-background/80 motion-reduce:animate-none">
      {header}
      <div className="max-h-64 overflow-y-auto p-1">{children}</div>
      {footer}
    </div>
  );
}

function ComposerPopoverHeader({
  children,
  accessory,
}: {
  children: ReactNode;
  accessory?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2 text-[11px] font-medium text-muted-foreground">
      <span>{children}</span>
      {accessory}
    </div>
  );
}

// The ↑↓ / ↵ / esc keycap hints shared by the slash, mention, and channel menus.
function ComposerPopoverHint() {
  const kbd = "rounded border border-border/60 bg-muted/50 px-1 py-px font-mono text-[9px]";
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border/40 px-2.5 py-1.5 text-[10px] text-muted-foreground/80">
      <span className="inline-flex items-center gap-1">
        <kbd className={kbd}>↑</kbd>
        <kbd className={kbd}>↓</kbd>
        navigate
      </span>
      <span className="inline-flex items-center gap-1">
        <kbd className={kbd}>↵</kbd>
        select
      </span>
      <span className="inline-flex items-center gap-1">
        <kbd className={kbd}>esc</kbd>
        close
      </span>
    </div>
  );
}

const ADMIN_CATEGORY_LABEL: Record<AdminCommandCategory, string> = {
  session: "Session control",
  "usage-help": "Usage & help",
};

// Faintly box the part of the command that matches what's typed so the match is
// scannable. Monochrome on purpose — hue is reserved for the semantic tile.
function highlightCommand(command: string, query: string): ReactNode {
  if (!query) return command;
  const idx = command.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return command;
  return (
    <>
      {command.slice(0, idx)}
      <span className="rounded-[3px] bg-foreground/10">
        {command.slice(idx, idx + query.length)}
      </span>
      {command.slice(idx + query.length)}
    </>
  );
}

function AdminCommandPopover({
  options,
  activeIndex,
  query,
  onSelect,
}: {
  options: readonly AdminCommandDefinition[];
  activeIndex: number;
  query: string;
  onSelect: (command: AdminCommandDefinition) => void;
}) {
  return (
    <ComposerPopoverFrame
      header={<ComposerPopoverHeader>Agent commands</ComposerPopoverHeader>}
      footer={<ComposerPopoverHint />}
    >
      {options.map((item, idx) => {
        const selected = idx === activeIndex;
        // First row of each category gets a section header. Derived from the
        // previous row (no mutable accumulator) so it's render-pure.
        const prev = idx > 0 ? options[idx - 1] : undefined;
        const showHeader = prev?.category !== item.category;
        return (
          <Fragment key={item.kind}>
            {showHeader && (
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 first:pt-1">
                {ADMIN_CATEGORY_LABEL[item.category]}
              </div>
            )}
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                selected
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
              )}
            >
              <AdminCommandGlyph kind={item.kind} />
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <code className="shrink-0 font-mono text-[13px] font-semibold text-foreground">
                  {highlightCommand(item.command, query)}
                </code>
                <span className="truncate text-xs text-muted-foreground">
                  {item.description}
                </span>
              </span>
              {selected && (
                <kbd className="ml-1 shrink-0 rounded border border-border/60 bg-muted/50 px-1 py-px font-mono text-[9px] text-muted-foreground">
                  ↵
                </kbd>
              )}
            </button>
          </Fragment>
        );
      })}
    </ComposerPopoverFrame>
  );
}

export interface MentionItem {
  key: string;
  label: string;
  handle: string;
  /** The channel member this row mentions. Absent for the special
   *  ``@here`` broadcast row, which addresses everyone rather than a
   *  specific member. */
  member?: MmChannelMember;
  /** Marks a non-member broadcast token. Currently only ``"here"``. */
  special?: "here";
}

function MentionPopover({
  options,
  activeIndex,
  onSelect,
}: {
  options: MentionItem[];
  activeIndex: number;
  onSelect: (handle: string) => void;
}) {
  return (
    <ComposerPopoverFrame footer={<ComposerPopoverHint />}>
      {options.map((item, idx) => {
          const selected = idx === activeIndex;
          const rowClass = `flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
            selected
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
          }`;
          // ``@here`` broadcast row — no member, its own glyph + helper text.
          if (item.special === "here" || !item.member) {
            return (
              <button
                key={item.key}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(item.handle);
                }}
                className={rowClass}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-mention/15 text-mention">
                  <Icon icon={UserMultipleIcon} className="size-3.5"/>
                </span>
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground">{item.label}</span>
                  <span className="truncate text-xs text-muted-foreground">Notify everyone in the channel</span>
                </span>
              </button>
            );
          }
          const isAgent = Boolean(item.member.agent_id);
          const avatarSeed = isAgent
            ? (item.member.display_name ?? item.member.agent_id ?? item.handle)
            : (item.member.human_id != null
                ? String(item.member.human_id)
                : item.handle);
          return (
            <button
              key={item.key}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item.handle);
              }}
              className={rowClass}
            >
              <span className="shrink-0">
                {isAgent
                  ? <AgentFaceAvatar size={24} name={avatarSeed} src={item.member.avatar?.url} framed={false}/>
                  : <UserAvatar size={24} name={avatarSeed} src={item.member.avatar?.url}/>}
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="truncate text-sm font-medium text-foreground">{item.label}</span>
                <span className="truncate text-xs text-muted-foreground">@{item.handle}</span>
              </span>
              <Icon
                icon={isAgent ? BotIcon : UserIcon}
                className="ml-2 size-3.5 shrink-0 text-muted-foreground/70"
                aria-label={isAgent ? "Agent" : "Human"}
              />
            </button>
          );
        })}
    </ComposerPopoverFrame>
  );
}

export interface EmojiShortcodeItem {
  name: string;
  emoji: string;
}

function EmojiShortcodePopover({
  options,
  activeIndex,
  onSelect,
}: {
  options: EmojiShortcodeItem[];
  activeIndex: number;
  onSelect: (emoji: string) => void;
}) {
  return (
    <ComposerPopoverFrame header={<ComposerPopoverHeader>Emoji</ComposerPopoverHeader>}>
      {options.map((item, idx) => {
          const selected = idx === activeIndex;
          return (
            <button
              key={item.name}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item.emoji);
              }}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left transition-colors ${
                selected
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              }`}
            >
              <span className="text-xl leading-none">{item.emoji}</span>
              <span className="text-sm text-foreground/85">:{item.name}:</span>
            </button>
          );
        })}
    </ComposerPopoverFrame>
  );
}

// ----------------------------------------------------------------------------
// ``#channel`` autocomplete — twin of MentionPopover. Each row shows the
// channel glyph + name + (display name when set) + a "Member" / "Join to
// view" hint. Selection inserts ``#channel-name `` at the caret.
// ----------------------------------------------------------------------------

export interface ChannelItem {
  key: string;
  /** Lowercased channel name — what the tokenizer matches against. */
  token: string;
  channel: MmChannel;
  /** True when the viewer is already a member. Drives the side-hint
   *  and (later) the click-fork on the rendered chip. */
  isMember: boolean;
}

function ChannelPopover({
  options,
  activeIndex,
  onSelect,
}: {
  options: ChannelItem[];
  activeIndex: number;
  onSelect: (token: string) => void;
}) {
  return (
    <ComposerPopoverFrame footer={<ComposerPopoverHint />}>
      {options.map((item, idx) => {
          const selected = idx === activeIndex;
          const display = item.channel.display_name ?? item.channel.name;
          const isPrivate = item.channel.channel_type === "private";
          return (
            <button
              key={item.key}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item.token);
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                selected
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              }`}
            >
              <span className="shrink-0">
                <ChannelGlyph channel={item.channel} size={20} showPresenceDot={false}/>
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="truncate text-sm font-medium text-foreground">
                  {display}
                </span>
                {display !== item.channel.name && (
                  <span className="truncate text-xs text-muted-foreground">
                    #{item.channel.name}
                  </span>
                )}
              </span>
              <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {!item.isMember
                  ? "Join to view"
                  : isPrivate
                    ? "Private"
                    : "Member"}
              </span>
            </button>
          );
        })}
    </ComposerPopoverFrame>
  );
}

// ----------------------------------------------------------------------------
// Agent target chip — the "who am I addressing" surface. When the channel has
// agents, the chip lives in the action row. It reflects either the user's
// manual pick or the auto-mention (in that order). Dismissing the chip either
// clears the manual pick OR dismisses the auto-mention, depending on which is
// driving the current target.
// ----------------------------------------------------------------------------

function agentLabel(m: MmChannelMember): string {
  return m.display_name?.trim() || m.agent_id || "Agent";
}

function AgentTargetChip({
  agents,
  manualHandle,
  autoMentionHandle,
  pulseKey,
  onPick,
  onClear,
}: {
  agents: (MmChannelMember & { agent_id: string })[];
  manualHandle: string | null;
  autoMentionHandle: string | null;
  pulseKey: string | null;
  onPick: (handle: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pulsing, setPulsing] = useState(false);
  const lastPulseKeyRef = useRef<string | null>(null);

  // Brief background flash when an auto-mention trigger first appears so the
  // user notices that the next send is now addressed to an agent.
  useEffect(() => {
    if (!pulseKey) return;
    if (pulseKey === lastPulseKeyRef.current) return;
    lastPulseKeyRef.current = pulseKey;
    setPulsing(true);
    const t = window.setTimeout(() => { setPulsing(false); }, 1400);
    return () => { window.clearTimeout(t); };
  }, [pulseKey]);

  const targetHandle = manualHandle ?? autoMentionHandle ?? null;
  const targetAgent = useMemo(
    () => (targetHandle ? agents.find((a) => a.agent_id === targetHandle) ?? null : null),
    [agents, targetHandle],
  );

  if (agents.length === 0) return null;

  const idle = targetAgent == null;
  const baseClass =
    "group flex h-7 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-full pl-1.5 pr-2 text-xs leading-none transition-colors";
  const stateClass = idle
    ? "border border-dashed border-border/60 px-2 text-muted-foreground hover:border-border hover:text-foreground"
    : "bg-mention/12 text-mention ring-1 ring-mention/25 hover:bg-mention/20";
  const pulseClass = pulsing && !idle ? "animate-target-pulse" : "";

  const seed = targetAgent
    ? (targetAgent.display_name ?? targetAgent.agent_id)
    : null;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        render={
          <button
            type="button"
            tabIndex={-1}
            aria-label={
              idle
                ? "Target an agent"
                : `Targeting @${targetAgent?.agent_id ?? ""} - click to change or clear`
            }
            className={`${baseClass} ${stateClass} ${pulseClass}`}
          >
            {targetAgent ? (
              <AgentFaceAvatar size={18} name={seed ?? ""} src={targetAgent.avatar?.url} framed={false}/>
            ) : (
              <Icon icon={Robot02Icon} className="size-4 shrink-0"/>
            )}
            <span className="truncate font-medium">
              {targetAgent ? `@${targetAgent.agent_id}` : "Agent"}
            </span>
            {!idle && (
              <span
                role="button"
                tabIndex={-1}
                aria-label="Clear target"
                onMouseDown={(e) => {
                  // mousedown so the parent popover doesn't toggle.
                  e.preventDefault();
                  e.stopPropagation();
                  onClear();
                }}
                className="-mr-1 flex size-4 items-center justify-center rounded-full text-mention/70 transition-colors hover:bg-mention/20 hover:text-mention"
              >
                <Icon icon={Cancel01Icon} className="size-2.5"/>
              </span>
            )}
          </button>
        }
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align="start"
          side="top"
          sideOffset={8}
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup className="z-50 w-64 origin-(--transform-origin) overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-lg ring-1 ring-foreground/5 backdrop-blur-xl data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Target agent
              </span>
              <span className="text-[10px] tabular-nums text-muted-foreground/70">
                ⌘J
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {agents.map((a) => {
                const active = a.agent_id === targetHandle;
                return (
                  <button
                    key={a.agent_id}
                    type="button"
                    onClick={() => {
                      onPick(a.agent_id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      active
                        ? "bg-mention/10 text-foreground"
                        : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                    }`}
                  >
                    <AgentFaceAvatar
                      size={24}
                      name={a.display_name ?? a.agent_id}
                      src={a.avatar?.url}
                      framed={false}
                    />
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {agentLabel(a)}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        @{a.agent_id}
                      </span>
                    </span>
                    {active && (
                      <span className="ml-2 size-1.5 shrink-0 rounded-full bg-mention"/>
                    )}
                  </button>
                );
              })}
            </div>
            {!idle && (
              <button
                type="button"
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
                className="flex w-full items-center justify-center gap-1.5 border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                <Icon icon={Cancel01Icon} className="size-3"/>
                Clear target
              </button>
            )}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// ----------------------------------------------------------------------------
// Keyboard cheatsheet — no longer a visible button on the action row (that
// row is kept to its load-bearing controls). Opened only via ⌘/, and anchored
// to the composer wrapper so it still positions correctly without a trigger.
// Markdown bold/italic stay on ⌘B / ⌘I (see ``handleKeyDown``); the other GFM
// formats are typed as literal markdown, which the renderer supports.
// ----------------------------------------------------------------------------

function ShortcutsCheatsheet({
  open,
  onOpenChange,
  anchor,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  anchor: RefObject<HTMLElement | null>;
}) {
  const isMac =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";
  const items: { keys: string[]; label: string }[] = [
    { keys: ["↵"], label: "Send message" },
    { keys: ["⇧", "↵"], label: "New line" },
    { keys: [mod, "B"], label: "Bold" },
    { keys: [mod, "I"], label: "Italic" },
    { keys: [mod, "J"], label: "Target agent" },
    { keys: [mod, "⇧", "J"], label: "Cycle agent" },
    { keys: [mod, ";"], label: "Emoji picker" },
    { keys: ["/"], label: "Agent commands" },
    { keys: ["@"], label: "Mention someone" },
    { keys: [":"], label: "Emoji shortcode" },
    { keys: ["Esc"], label: "Close · cancel reply · clear target" },
    { keys: [mod, "/"], label: "This cheatsheet" },
  ];
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
            <div className="border-b border-border/40 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
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

// ----------------------------------------------------------------------------
// Send button - Claude-style. Idle (no content) is a muted ghost; the moment
// there's send-able content the background morphs to `primary`. Upload state
// swaps the icon for an inline spinner so the user knows we're waiting.
// Anchored bottom-right of the capsule's action row - the single colour
// accent on the surface.
// ----------------------------------------------------------------------------

function SendButton({
  canSend,
  sending,
  uploading,
}: {
  canSend: boolean;
  sending: boolean;
  uploading: boolean;
}) {
  const disabled = !canSend || sending || uploading;
  const busy = sending || uploading;
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-label={uploading ? "Waiting for uploads" : "Send message"}
      className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
        canSend && !busy
          ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95"
          : busy
            ? "bg-primary/60 text-primary-foreground"
            : "bg-muted/60 text-muted-foreground"
      }`}
    >
      {busy ? (
        <span
          aria-hidden
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        <Icon icon={ArrowUp02Icon} className="size-[18px]"/>
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
  onInsertAtCaret: (text: string) => void;

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

  // Jump-to-latest — when the chat is scrolled away from the bottom we
  // render a compact icon button above the pill, aligned with the send
  // button, so the user can snap back without hunting for a control.
  isChatAtBottom: boolean;
  onScrollChatToBottom: () => void;

  // Typing / generating indicator — rendered as a thin row directly
  // above the composer pill (modern convention; see ``TypingRow``).
  // ``activityLabel`` is the text fallback for screen readers;
  // ``activityPeople`` is the live list of peers currently typing or
  // generating (excluding self).
  activityLabel?: string | null;
  activityPeople?: ReadonlyArray<{
    key: string;
    displayName: string;
    status: "typing" | "generating";
  }>;

  // Misc
  adminCommandsEnabled?: boolean;
  onTyping?: () => void;
  /** Contextual placeholder, e.g. "Message #general" / "Message Anna".
   *  Falls back to the generic prompt. */
  placeholder?: string;
}

export function MessageComposer(props: MessageComposerProps) {
  const {
    isMobile,
    wrapperRef,
    inputRef,
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
    onInsertAtCaret,
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
    adminCommandsEnabled = false,
    onTyping,
    placeholder,
  } = props;

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // The highlight overlay (`data-composer-sizer`) renders the *visible* text;
  // the textarea above it is transparent. Their scroll positions must track
  // each other, or long drafts clip the overlay while the textarea scrolls on.
  const sizerRef = useRef<HTMLDivElement | null>(null);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [activeAdminCommand, setActiveAdminCommand] = useState({ key: "", index: 0 });
  const [dismissedAdminCommandKey, setDismissedAdminCommandKey] = useState<string | null>(null);

  const adminCommandMatch = useMemo(
    () => (adminCommandsEnabled ? extractAdminCommandQuery(draft, caretPos) : null),
    [adminCommandsEnabled, draft, caretPos],
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
    adminCommandsEnabled && !adminCommandDismissed && adminCommandMatch && adminCommandOptions.length > 0,
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

    // Agent target shortcuts
    if ((e.metaKey || e.ctrlKey) && (e.key === "J" || e.key === "j")) {
      e.preventDefault();
      if (e.shiftKey) {
        cycleAgent();
      } else {
        // Toggle the chip popover by clicking its trigger button. The span
        // wrapper carries the data-attribute (so we can target it from the
        // textarea), but it's `display: contents`, so the trigger button is
        // a direct child.
        const wrap = wrapperRef.current;
        const btn = wrap?.querySelector<HTMLButtonElement>('[data-composer-agent-trigger] button');
        btn?.click();
      }
      return;
    }

    // Emoji picker
    if ((e.metaKey || e.ctrlKey) && e.key === ";") {
      e.preventDefault();
      const wrap = wrapperRef.current;
      const btn = wrap?.querySelector<HTMLButtonElement>('[data-composer-emoji-trigger] button');
      btn?.click();
      return;
    }

    // Escape ladder: cheatsheet → reply → target. The "Esc to cancel"
    // hint next to the agent chip promises the third rung regardless of
    // draft content — clearing the target preserves the draft so the
    // user doesn't lose what they were writing.
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
  const formId = useId();

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
          : `pointer-events-none absolute inset-x-0 z-10 px-3 pb-[var(--safe-bottom)] max-md:px-2 ${isDesktop ? "bottom-2" : "bottom-1.5"}`
      }
    >
      {/* Outer wrapper spans full width for the height-measurement observer
          in ChannelPage; inner ``max-w-chat`` keeps the composer pill the
          same width as the message column. The extra ``px-0.5`` mirrors the
          message rows' ``mx-0.5`` inset so the pill's edges line up exactly
          with the rows rather than overhanging them by 2px each side. */}
      <div className="pointer-events-auto relative mx-auto max-w-chat px-0.5">
        {/* Jump-to-latest — anchored above the pill, right-edge aligned
            with the send button (`right-2` mirrors the row's `pr-2`) so it
            reads as a control that's part of the composer rather than a
            floating chip. `rounded-xl` echoes the pill's own corner radius. */}
        {!isChatAtBottom && (
          <button
            type="button"
            onClick={onScrollChatToBottom}
            aria-label="Jump to latest"
            className="absolute bottom-full right-2 mb-2 flex size-8 items-center justify-center rounded-lg border border-border/60 bg-background/70 text-muted-foreground shadow-sm backdrop-blur-xl transition-all hover:border-border hover:bg-background hover:text-foreground supports-[backdrop-filter]:bg-background/55"
          >
            <Icon icon={ArrowDown02Icon} className="size-3.5"/>
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
          id={formId}
          className="flex flex-col rounded-2xl border border-border/50 bg-background/95 backdrop-blur-xl backdrop-saturate-150 transition-colors focus-within:border-border supports-[backdrop-filter]:bg-background/85 max-md:rounded-3xl"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >{/* One capsule holds everything (2026 AI-composer anatomy):
              context strips on top, growing textarea in the middle, and a
              pinned action row at the bottom - input sources (attach,
              agent target) on the left, expression + send on the right.
              Send is the only colour accent on the surface. */}
          {/* Context strip: reply quote. No hairline — breathing room
              and the small accent bar carry the visual separation. */}
          {replyingTo && (
            <div className="flex items-center gap-2.5 px-4 pt-3 pb-1">
              <span aria-hidden className="h-3.5 w-0.5 shrink-0 rounded-full bg-primary/60"/>
              <span className="min-w-0 flex-1 truncate text-[12px] leading-tight">
                <span className="text-muted-foreground">Replying to </span>
                <span className="font-medium text-foreground/90">{replyPosterName(replyingTo)}</span>
                <span className="text-muted-foreground"> · </span>
                <span className="text-muted-foreground">{(replyingTo.message || "").trim() || "(empty message)"}</span>
              </span>
              <button
                type="button"
                onClick={onCancelReply}
                aria-label="Cancel reply"
                className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Icon icon={Cancel01Icon} className="size-3"/>
              </button>
            </div>
          )}

          {/* Context strip: attachments — chip row, no hairline. */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2 pt-2 pb-0.5">
              {attachments.map((a) => (
                <AttachmentChip
                  key={a.localId}
                  attachment={{
                    localId: a.localId,
                    file: a.file,
                    status: a.status,
                    progress: a.progress,
                    error: a.error,
                  }}
                  onRemove={onAttachmentRemove}
                />
              ))}
            </div>
          )}

          {/* Hidden file input — triggered by the attach button. */}
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

          {/* Writing surface - full-width now that send lives in the action
              row below, so the textarea owns the whole line. */}
          <div className="grid min-w-0 px-4 pt-3">
            {/* Auto-grow sizer + highlight layer. This div sits in normal
                flow as a grid cell, so it drives the row height; the
                textarea is stacked in the SAME cell (`grid-area:1/1`) and
                stretches to match. Replaces `field-sizing: content`, which
                Firefox and Safari don't support - so the box now grows with
                multi-line drafts in every browser. The trailing space
                reserves height for a final empty line when the draft ends
                in a newline (an empty last line has no box otherwise). */}
            <div
              ref={sizerRef}
              aria-hidden="true"
              data-composer-sizer=""
              // Font-size MUST stay in lockstep with the textarea below (caret
              // alignment). Both are bumped to 16px on touch by the single
              // pointer:coarse rule in index.css — the textarea via its tag,
              // this sizer via [data-composer-sizer] — to stop iOS focus-zoom.
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
                // Keep the (transparent) textarea and the highlight overlay
                // scrolled in lockstep. Without this, drafts taller than
                // max-h-[40vh] scroll the caret but freeze the visible text.
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

          {/* Action row - pinned inside the capsule's bottom edge. Left
              cluster: controls that shape the outgoing message (attach,
              agent target). Right cluster: expression + send, frequency
              increasing toward the corner (shortcuts, format, emoji,
              send). 28px targets on a 4px grid. */}
          <div className="flex items-center gap-1 px-2 pb-2 pt-1.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Add attachment"
                    className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Icon icon={AttachmentIcon} className="size-4"/>
                  </button>
                }
              />
              <TooltipContent side="top" sideOffset={6} className="text-xs">Attach files</TooltipContent>
            </Tooltip>

            <span data-composer-agent-trigger="" className="contents">
              <AgentTargetChip
                agents={agents}
                manualHandle={manualTargetHandle}
                autoMentionHandle={autoMention?.handle ?? null}
                pulseKey={autoMention?.triggerKey ?? null}
                onPick={(h) => { onSetManualTarget(h); refocusInput(); }}
                onClear={() => { clearTarget(); refocusInput(); }}
              />
            </span>

            <div className="ml-auto flex items-center gap-1">
              {showCounter && (
                <span
                  aria-live="polite"
                  className={`px-1 text-[10px] tabular-nums ${
                    remaining <= 0
                      ? "font-medium text-destructive"
                      : remaining < 100
                        ? "text-destructive/80"
                        : "text-muted-foreground/70"
                  }`}
                >
                  {remaining <= 0 ? `Max ${String(MAX_LEN)} reached` : remaining}
                </span>
              )}
              {/* Keyboard-shortcuts cheatsheet — no visible button; opens via
                  ⌘/ only, anchored to the composer. Renders nothing inline. */}
              <ShortcutsCheatsheet
                open={cheatsheetOpen}
                onOpenChange={setCheatsheetOpen}
                anchor={wrapperRef}
              />
              {/* Emoji picker — hidden on mobile (the OS keyboard has its own
                  emoji input; the :shortcode: autocomplete still works). */}
              <span data-composer-emoji-trigger="" className="contents max-md:hidden">
                <EmojiPickerButton onSelect={onInsertAtCaret} compact/>
              </span>
              <SendButton canSend={canSend} sending={isSending} uploading={isUploading}/>
            </div>
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
  people: ReadonlyArray<{
    key: string;
    displayName: string;
    status: "typing" | "generating";
  }>;
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
      className="flex h-4 min-w-0 items-center px-3"
    >
      {/* No chip / no fill / no halo — a subtle ``backdrop-blur`` on
          the inline content softens whatever chat text scrolls behind,
          which is enough to keep the indicator legible without the
          harsh dark glow a text-shadow halo produces. The blur only
          renders when the indicator is mounted (i.e. someone is
          actively typing); the empty slot stays fully transparent. */}
      <span className="animate-typing-row-in inline-flex min-w-0 items-center gap-1.5 rounded-full bg-background/70 px-1.5 py-0.5 backdrop-blur-sm supports-[backdrop-filter]:bg-background/50">
        <span className="min-w-0 truncate text-[11px] leading-none text-muted-foreground/80">
          <span className="text-foreground/75">{nameText}</span>{" "}
          <span>{auxiliary} {verb}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-[2px]" aria-hidden="true">
          <span className="typing-dot block size-[3.5px] rounded-full bg-foreground/45"/>
          <span className="typing-dot block size-[3.5px] rounded-full bg-foreground/45"/>
          <span className="typing-dot block size-[3.5px] rounded-full bg-foreground/45"/>
        </span>
      </span>
    </div>
  );
}

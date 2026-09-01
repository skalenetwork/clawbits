/**
 * The composer's four autocomplete popovers — slash commands, @mentions,
 * #channels and :emoji — plus the frosted panel they share. Each renders a
 * list and reports the pick; selection state and keyboard routing stay with
 * the composer, which is what makes them interchangeable.
 */
import { Fragment, type ReactNode } from "react";

import { AdminCommandGlyph } from "@/components/AdminCommandGlyph";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { ChannelGlyph } from "@/components/ChannelGlyph";
import { Icon } from "@/components/Icon";
import { UserAvatar } from "@/components/UserAvatar";
import { BotIcon, UserIcon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import type { AdminCommandCategory, AdminCommandDefinition } from "@/lib/adminCommands";
import { cn } from "@/lib/utils";
import type { MmChannel, MmChannelMember } from "@/lib/api";

// One frosted panel anchored above the composer, scaling up on open (matching
// the app's other popovers). Header + footer are slots so each popover keeps
// its own contents. React keeps this element mounted while a popover stays
// open, so the entrance animation plays once, not per keystroke.
export function ComposerPopoverFrame({
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

export function ComposerPopoverHeader({
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
export function ComposerPopoverHint() {
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

export function AdminCommandPopover({
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

export function MentionPopover({
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

export function EmojiShortcodePopover({
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

export function ChannelPopover({
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

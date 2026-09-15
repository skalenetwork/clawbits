import { Fragment, type ReactNode } from "react";

import { AdminCommandGlyph } from "@/components/AdminCommandGlyph";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { ChannelGlyph } from "@/components/ChannelGlyph";
import { Icon } from "@/components/Icon";
import { UserAvatar } from "@/components/UserAvatar";
import { UserIcon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { Bot } from "lucide-react";
import type { AdminCommandDefinition } from "@/lib/adminCommands";
import { MENU_ITEM, MENU_SEPARATOR, MENU_SHORTCUT, MENU_SURFACE } from "@/lib/menuSurface";
import { cn } from "@/lib/utils";
import type { MmChannel, MmChannelMember } from "@/lib/api";

export interface MentionItem {
  label: string;
  handle: string;
  member?: MmChannelMember;
}

export interface ChannelItem {
  token: string;
  channel: MmChannel;
  isMember: boolean;
}

interface EmojiShortcodeItem {
  name: string;
  emoji: string;
}

interface PopoverProps<T> {
  options: readonly T[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

function ComposerPopover<T>({
  options,
  activeIndex,
  onSelect,
  itemKey,
  group,
  children,
}: PopoverProps<T> & {
  itemKey: (item: T) => string;
  group?: (item: T) => string;
  children: (item: T) => ReactNode;
}) {
  return (
    <div className={cn(MENU_SURFACE, "absolute bottom-full left-10 right-12 mb-2 origin-bottom overflow-hidden p-0 duration-150 ease-out animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1 motion-reduce:animate-none")}>
      <div className="max-h-64 overflow-y-auto p-1">
        {options.map((item, idx) => (
          <Fragment key={itemKey(item)}>
            {group && idx > 0 && group(options[idx - 1]!) !== group(item) && <div className={MENU_SEPARATOR} />}
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(idx);
              }}
              className={cn(MENU_ITEM, "w-full text-left", idx === activeIndex ? "bg-accent" : "hover:bg-accent")}
            >
              {children(item)}
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// Monochrome on purpose: hue is reserved for the semantic tile.
function highlightCommand(command: string, query: string): ReactNode {
  const idx = query ? command.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (idx < 0) return command;
  return (
    <>
      {command.slice(0, idx)}
      <span className="rounded-[3px] bg-foreground/10">{command.slice(idx, idx + query.length)}</span>
      {command.slice(idx + query.length)}
    </>
  );
}

export function AdminCommandPopover({ query, ...props }: PopoverProps<AdminCommandDefinition> & { query: string }) {
  return (
    <ComposerPopover {...props} itemKey={(item) => item.kind} group={(item) => item.category}>
      {(item) => (
        <>
          <AdminCommandGlyph kind={item.kind} className="size-5" />
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <code className="shrink-0 font-mono font-medium">{highlightCommand(item.command, query)}</code>
            <span className="truncate text-xs text-muted-foreground">{item.description}</span>
          </span>
        </>
      )}
    </ComposerPopover>
  );
}

export function MentionPopover(props: PopoverProps<MentionItem>) {
  return (
    <ComposerPopover {...props} itemKey={(item) => (item.member ? item.handle : "@here")}>
      {({ label, handle, member }) =>
        member ? (
          <>
            <span className="shrink-0">
              {member.agent_id
                ? <AgentFaceAvatar size={20} name={member.display_name ?? member.agent_id} src={member.avatar?.url} framed={false}/>
                : <UserAvatar size={20} name={member.human_id != null ? String(member.human_id) : handle} src={member.avatar?.url}/>}
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="truncate">{label}</span>
              <span className="truncate text-xs text-muted-foreground">@{handle}</span>
            </span>
            <Icon
              icon={member.agent_id ? Bot : UserIcon}
              className="ml-2 size-3.5 shrink-0 text-muted-foreground"
              aria-label={member.agent_id ? "Agent" : "Human"}
            />
          </>
        ) : (
          <>
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-mention/15 text-mention">
              <Icon icon={UserMultipleIcon} className="size-3"/>
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="truncate">{label}</span>
              <span className="truncate text-xs text-muted-foreground">Notify everyone in the channel</span>
            </span>
          </>
        )
      }
    </ComposerPopover>
  );
}

export function EmojiShortcodePopover(props: PopoverProps<EmojiShortcodeItem>) {
  return (
    <ComposerPopover {...props} itemKey={(item) => item.name}>
      {({ name, emoji }) => (
        <>
          <span className="grid size-5 shrink-0 place-items-center text-base leading-none">{emoji}</span>
          <span className="truncate">:{name}:</span>
        </>
      )}
    </ComposerPopover>
  );
}

export function ChannelPopover(props: PopoverProps<ChannelItem>) {
  return (
    <ComposerPopover {...props} itemKey={(item) => item.channel.channel_id}>
      {({ channel, isMember }) => {
        const display = channel.display_name ?? channel.name;
        return (
          <>
            <span className="shrink-0">
              <ChannelGlyph channel={channel} size={20} showPresenceDot={false}/>
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="truncate">{display}</span>
              {display !== channel.name && <span className="truncate text-xs text-muted-foreground">#{channel.name}</span>}
            </span>
            <span className={MENU_SHORTCUT}>
              {!isMember ? "Join to view" : channel.channel_type === "private" ? "Private" : "Member"}
            </span>
          </>
        );
      }}
    </ComposerPopover>
  );
}

/**
 * InboxRow — one message in the list: tinted sender monogram, unread dot +
 * weight shift, subject, snippet, paperclip, relative time. The whole row is
 * the click target (overlay button, AutomationCard-style) so the hover
 * quick-actions (mark read/unread, delete) can sit above it; on touch the
 * actions live in the message view instead.
 */
import { useRef } from "react";
import {
  Attachment01Icon,
  Delete02Icon,
  Mail01Icon,
  MailOpen01Icon,
  Robot02Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelativeShort } from "@/lib/formatting";
import type { EmailSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { initials, isPlatformAddress, senderAccent, senderName } from "./emailDisplay";

function QuickAction({
  label,
  icon,
  destructive,
  onClick,
}: {
  label: string;
  icon: typeof Mail01Icon;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            // Quick actions are hover affordances, not the row's tab stops —
            // keyboard users have dedicated keys (u / ⌫) via the page.
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
            className={cn(
              "flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors",
              destructive ? "hover:bg-destructive/10 hover:text-destructive" : "hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon icon={icon} className="size-4" />
          </button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function InboxRow({
  email,
  selected,
  tabbable,
  entered,
  onOpen,
  onToggleRead,
  onDelete,
}: {
  email: EmailSummary;
  /** The message currently open in the reading pane / detail route. */
  selected: boolean;
  /** Roving tabindex — exactly one row is the list's tab stop. */
  tabbable: boolean;
  /** Landed in this poll cycle — enters with the settle animation. */
  entered?: boolean;
  /** Open the message; receives the row element as the mobile morph source. */
  onOpen: (uid: number, sourceEl: HTMLElement | null) => void;
  onToggleRead: (uid: number, read: boolean) => void;
  onDelete: (uid: number) => void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const name = senderName(email.from_addr);
  const unread = !email.is_read;
  const accent = senderAccent(email.from_addr);
  const fromAgent = isPlatformAddress(email.from_addr);
  const when = email.date ? formatRelativeShort(email.date) : "";

  return (
    <li
      ref={rowRef}
      data-uid={email.uid}
      className={cn(
        "group relative flex items-start gap-3 rounded-xl px-3 py-2.5",
        "transition-colors duration-150",
        selected ? "bg-muted/60" : "hover:bg-muted/40 active:bg-muted/60",
        entered && "animate-in fade-in slide-in-from-top-1 duration-300 motion-reduce:animate-none",
      )}
    >
      {/* Whole-row click target under the quick actions. */}
      <button
        type="button"
        aria-label={`${name}: ${email.subject || "(no subject)"}`}
        aria-current={selected ? "true" : undefined}
        tabIndex={tabbable ? 0 : -1}
        data-inbox-row={email.uid}
        onClick={() => {
          onOpen(email.uid, rowRef.current);
        }}
        className="absolute inset-0 z-0 cursor-pointer rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
      />

      {/* Sender monogram — soft accent tint; robot glyph for platform mail. */}
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-full",
          accent.bg,
          accent.text,
        )}
      >
        {fromAgent ? (
          <Icon icon={Robot02Icon} className="size-5" />
        ) : (
          <span className="text-[11px] font-semibold">{initials(name)}</span>
        )}
      </span>

      <div className="min-w-0 flex-1">
        {/* Line 1 — sender + meta. The time yields to quick actions on hover
            (fine pointers only); touch keeps the time and acts in the detail. */}
        <div className="flex h-5 items-center gap-1.5">
          {unread && (
            <span
              aria-hidden
              title="Unread"
              className="size-1.5 shrink-0 rounded-full bg-(--mention)"
            />
          )}
          <span
            className={cn(
              "truncate text-sm",
              unread ? "font-semibold text-foreground" : "font-normal text-muted-foreground",
            )}
          >
            {name}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {email.has_attachments === true && (
              <Icon icon={Attachment01Icon} className="size-3.5 text-muted-foreground/60" />
            )}
            {when && (
              <span className="text-xs text-muted-foreground/70 tabular-nums pointer-fine:group-hover:hidden">
                {when}
              </span>
            )}
            <span className="relative z-10 hidden items-center gap-0.5 pointer-fine:group-hover:flex">
              <QuickAction
                label={unread ? "Mark as read" : "Mark as unread"}
                icon={unread ? MailOpen01Icon : Mail01Icon}
                onClick={() => {
                  onToggleRead(email.uid, unread);
                }}
              />
              <QuickAction
                label="Delete"
                icon={Delete02Icon}
                destructive
                onClick={() => {
                  onDelete(email.uid);
                }}
              />
            </span>
          </span>
        </div>

        {/* Line 2 — subject. */}
        <div
          className={cn(
            "truncate text-sm leading-snug",
            unread ? "font-medium text-foreground/90" : "text-muted-foreground",
          )}
        >
          {email.subject || "(no subject)"}
        </div>

        {/* Line 3 — snippet, when the server could produce one. */}
        {email.snippet && (
          <div className="truncate text-xs leading-relaxed text-muted-foreground/70">
            {email.snippet}
          </div>
        )}
      </div>
    </li>
  );
}

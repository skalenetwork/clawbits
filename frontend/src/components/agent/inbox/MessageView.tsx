/**
 * MessageView — one message, fully rendered: icon toolbar, serif subject (the
 * page's single serif moment, same doctrine as the automation detail hero),
 * sender identity card, body (prose or hardened HTML frame), attachment
 * tiles, and the raw-headers disclosure. Shared by the desktop reading pane
 * (`variant="pane"`) and the mobile full-screen route (`variant="page"` —
 * which also carries the view-transition hero class for the row→page morph).
 */
import { useEffect, useRef, useState } from "react";
import {
  Cancel01Icon,
  CodeIcon,
  Copy01Icon,
  Delete02Icon,
  Robot02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelativeShort } from "@/lib/formatting";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { EmailDetail } from "@/lib/api";
import { AttachmentTiles } from "./AttachmentTiles";
import { HtmlEmailFrame } from "./HtmlEmailFrame";
import { RawHeaders } from "./RawHeaders";
import { extractAddress, initials, isPlatformAddress, senderAccent, senderName } from "./emailDisplay";
import { useAgentEmail, useInboxInvalidate } from "./useInbox";

function ToolbarButton({
  label,
  sublabel,
  icon,
  destructive,
  disabled,
  onClick,
}: {
  label: string;
  /** Muted second tooltip line — used for the shared-mailbox honesty note. */
  sublabel?: string;
  icon: IconSvgElement;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
            className={cn(
              "text-muted-foreground",
              destructive && "hover:bg-destructive/10 hover:text-destructive",
            )}
          >
            <Icon icon={icon} className="size-4" />
          </Button>
        }
      />
      <TooltipContent>
        {label}
        {sublabel && <span className="block text-muted-foreground">{sublabel}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function EmailBody({ detail }: { detail: EmailDetail }) {
  const text = detail.body_text?.trim();
  if (text) {
    return (
      <div className="max-w-[72ch] whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground/90">
        {text}
      </div>
    );
  }
  if (detail.body_html) return <HtmlEmailFrame html={detail.body_html} />;
  return <p className="text-[15px] italic text-muted-foreground">No content.</p>;
}

export function MessageView({
  orgId,
  agentId,
  uid,
  variant,
  onClose,
  onDelete,
  deletePending,
}: {
  orgId: string;
  agentId: string;
  uid: number;
  /** "pane" = desktop reading pane; "page" = mobile full-screen route. */
  variant: "pane" | "page";
  /** Desktop pane close (Esc / X). Unused on the mobile page (shell back). */
  onClose?: () => void;
  /** Delete flow lives with the page (shared with rows + keyboard). */
  onDelete: (uid: number) => void;
  deletePending: boolean;
}) {
  const detailQuery = useAgentEmail(orgId, agentId, uid);
  const invalidate = useInboxInvalidate(orgId, agentId);
  const [showHeaders, setShowHeaders] = useState(false);

  // Opening a message marks it \Seen server-side. Refresh the list + count
  // once (so the row de-bolds and the unread badge drops) without re-fetching
  // this message — that would loop.
  const marked = useRef(false);
  useEffect(() => {
    if (detailQuery.isSuccess && !marked.current) {
      marked.current = true;
      invalidate();
    }
  }, [detailQuery.isSuccess, invalidate]);

  if (detailQuery.isLoading) {
    return (
      <div className="space-y-3 pb-4">
        <Skeleton className="h-7 w-2/3" />
        <div className="flex items-center gap-3 pt-2">
          <Skeleton className="size-11 rounded-xl" />
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
        <Skeleton className="mt-2 h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  if (detailQuery.isError || !detailQuery.data) {
    return (
      <div className="py-8 text-sm text-muted-foreground">
        {errMsg(detailQuery.error, "Couldn't load message")}
      </div>
    );
  }

  const d = detailQuery.data;
  const name = senderName(d.from_addr);
  const address = extractAddress(d.from_addr);
  const accent = senderAccent(d.from_addr);
  const fromAgent = isPlatformAddress(d.from_addr);

  const copySenderAddress = () => {
    void navigator.clipboard.writeText(address);
    toast.success("Address copied");
  };

  return (
    <div className={cn("pb-8", variant === "pane" && "mx-auto w-full max-w-3xl")}>
      {/* Hero — subject with inline actions, then sender. On mobile this block
          is the morph target (the tapped row glides into it). */}
      <div className={cn(variant === "page" && "vt-inbox-message")}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-serif text-2xl leading-snug tracking-tight text-balance text-foreground">
            {d.subject || "(no subject)"}
          </h2>
          {/* Actions — icon-first, labels in tooltips. */}
          <div className="flex shrink-0 items-center gap-0.5 pt-1">
            <ToolbarButton
              label={deletePending ? "Deleting…" : "Delete"}
              icon={Delete02Icon}
              destructive
              disabled={deletePending}
              onClick={() => {
                onDelete(uid);
              }}
            />
            <ToolbarButton
              label={showHeaders ? "Hide technical details" : "Technical details"}
              icon={CodeIcon}
              onClick={() => {
                setShowHeaders((v) => !v);
              }}
            />
            {variant === "pane" && onClose && (
              <ToolbarButton label="Close" icon={Cancel01Icon} onClick={onClose} />
            )}
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <span
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-xl",
              accent.bg,
              accent.text,
            )}
          >
            {fromAgent ? (
              <Icon icon={Robot02Icon} className="size-5" />
            ) : (
              <span className="text-xs font-semibold">{initials(name)}</span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{name}</div>
            <button
              type="button"
              onClick={copySenderAddress}
              title="Copy address"
              className="group block max-w-full truncate text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {address}
              <Icon
                icon={Copy01Icon}
                className="ml-1 inline size-3 align-[-1px] opacity-0 transition-opacity group-hover:opacity-60"
              />
            </button>
          </div>
          {d.date && (
            <div
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
              title={d.date}
            >
              {formatRelativeShort(d.date)}
            </div>
          )}
        </div>
      </div>

      {showHeaders && (
        <div className="mt-4 space-y-3">
          <div className="truncate text-caption text-muted-foreground">to {d.to_addr}</div>
          <RawHeaders headers={d.headers} />
        </div>
      )}

      {/* Body + attachments. */}
      <div className="mt-5 border-t border-border/60 pt-6">
        <EmailBody detail={d} />
        {d.attachments.length > 0 && (
          <div className="mt-8">
            <AttachmentTiles attachments={d.attachments} />
          </div>
        )}
      </div>
    </div>
  );
}

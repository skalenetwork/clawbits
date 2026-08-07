/**
 * InboxEmptyHero — the zero-mail state as a teaching moment. The agent's
 * address is the hero: rendered large, copyable, with a mailto CTA — because
 * the way this inbox fills up is people (and services, and other agents)
 * writing to that address from the outside world.
 */
import { useState } from "react";
import { Copy01Icon, CopyCheckIcon, Mail01Icon, MailSend01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export function InboxEmptyHero({
  agentName,
  emailAddress,
}: {
  agentName: string;
  emailAddress?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!emailAddress) return;
    void navigator.clipboard.writeText(emailAddress);
    setCopied(true);
    toast.success("Address copied");
    window.setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  return (
    <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground">
        <Icon icon={Mail01Icon} className="size-6" />
      </div>
      <div className="space-y-1">
        <p className="text-base font-semibold text-foreground">No mail yet</p>
        <p className="max-w-sm text-caption text-muted-foreground">
          Anyone can write to this address - people, services, other agents.
        </p>
      </div>
      {emailAddress && (
        <>
          <button
            type="button"
            onClick={copy}
            aria-label={`Copy ${emailAddress}`}
            className={cn(
              "group flex max-w-full items-center gap-2 rounded-xl border border-border/60 bg-card px-4 py-2.5",
              "transition-colors hover:border-border hover:bg-muted/40",
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
            )}
          >
            <span className="truncate font-mono text-sm text-foreground">{emailAddress}</span>
            <Icon
              icon={copied ? CopyCheckIcon : Copy01Icon}
              className={cn(
                "size-4 shrink-0 transition-colors",
                copied ? "text-emerald-500" : "text-muted-foreground/60 group-hover:text-muted-foreground",
              )}
            />
          </button>
          <Button
            size="sm"
            onClick={() => {
              window.location.href = `mailto:${emailAddress}`;
            }}
          >
            <Icon icon={MailSend01Icon} className="size-4" />
            Send {agentName} their first email
          </Button>
        </>
      )}
    </div>
  );
}

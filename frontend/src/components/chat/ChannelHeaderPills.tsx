import type { ReactNode } from "react";

import { PresenceDot } from "@/components/PresenceDot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUserStatus } from "@/hooks/useUserPresence";
import { cn } from "@/lib/utils";

/** Trailing presence dot for the DM channel-page header pill — sits at
 *  the right end of the pill, no text label, matching channel-pill height. */
export function DmPillStatus({ humanId }: { humanId: number }) {
  const status = useUserStatus(humanId);
  return (
    <PresenceDot status={status} size={8} ringClassName="ring-background/40" />
  );
}

/** A channel header button that shows or hides one of the right panels. */
export function PanelToggle({
  open,
  onToggle,
  noun,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  noun: string;
  children: ReactNode;
}) {
  const label = `${open ? "Hide" : "Show"} ${noun}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onToggle}
            aria-pressed={open}
            aria-label={label}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors",
              open
                ? "bg-sidebar-foreground/10 text-foreground"
                : "text-muted-foreground hover:bg-sidebar-foreground/5 hover:text-foreground",
            )}
          >
            {children}
          </button>
        }
      />
      <TooltipContent side="bottom" align="end">{label}</TooltipContent>
    </Tooltip>
  );
}

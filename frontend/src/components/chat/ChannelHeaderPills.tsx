import type { ReactNode, Ref } from "react";

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
  detail,
  ref,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  noun: string;
  /** How what it shows stands, e.g. a game's state: said after its name, and beneath it in the tooltip. */
  detail?: string;
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  const label = `${open ? "Hide" : "Show"} ${noun}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={ref}
            type="button"
            onClick={onToggle}
            aria-pressed={open}
            aria-label={detail ? `${label}, ${detail}` : label}
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
      <TooltipContent side="bottom" align="end">
        {detail ? (
          <span className="flex flex-col gap-0.5">
            {label}
            <span className="text-background/70">{detail}</span>
          </span>
        ) : label}
      </TooltipContent>
    </Tooltip>
  );
}

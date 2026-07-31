/**
 * Stagger — the house staggered fade + rise for the manage sections, the same
 * enter animation the home launchpad blocks and the agent card's nav pills
 * use. ``fill-mode: both`` holds the from-state through the delay (no flash);
 * ``motion-reduce:animate-none`` shows sections instantly instead.
 */
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Stagger({
  delay,
  className,
  children,
}: {
  delay: number;
  className?: string;
  children: ReactNode;
}) {
  const style: CSSProperties = {
    animationDelay: `${String(delay)}ms`,
    animationFillMode: "both",
  };
  return (
    <div
      style={style}
      className={cn(
        "animate-in fade-in slide-in-from-bottom-2 duration-500 ease-out motion-reduce:animate-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

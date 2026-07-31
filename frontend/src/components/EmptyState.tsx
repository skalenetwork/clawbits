import type { ReactNode } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/Icon";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** Hugeicons icon — single glyph, not an illustration. */
  icon: IconSvgElement;
  title: string;
  /** Optional secondary line. Keep it short — one sentence max. */
  description?: string;
  /** Optional CTA slot. Usually a Button. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-16 text-center",
        className,
      )}
    >
      <div className="flex size-11 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground">
        <Icon icon={icon} className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && (
          <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

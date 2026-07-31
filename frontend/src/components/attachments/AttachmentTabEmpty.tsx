import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/Icon";

/** Centered empty state shared by the Media / Files / Links tabs. */
export function AttachmentTabEmpty({
  icon,
  title,
  subtitle,
}: {
  icon: IconSvgElement;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-muted/50">
        <Icon icon={icon} className="size-6 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-[15rem] text-xs text-muted-foreground">{subtitle}</p>
    </div>
  );
}

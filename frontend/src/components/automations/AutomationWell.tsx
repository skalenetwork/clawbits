import { Clock05Icon } from "@hugeicons/core-free-icons";
import { Icon, type AppIcon } from "@/components/Icon";
import { ACCENT_BG, type AutomationAccent } from "@/lib/automations";
import { cn } from "@/lib/utils";

export function AutomationWell({
  accent,
  icon = Clock05Icon,
  large = false,
}: {
  accent: AutomationAccent | null;
  icon?: AppIcon;
  large?: boolean;
}) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center",
        large ? "size-10 rounded-[11px]" : "size-8 rounded-[9px]",
        accent ? [ACCENT_BG[accent], "text-white"] : "bg-foreground/6 text-muted-foreground",
      )}
    >
      <Icon icon={icon} className={large ? "size-[18px]" : "size-4"} />
    </span>
  );
}

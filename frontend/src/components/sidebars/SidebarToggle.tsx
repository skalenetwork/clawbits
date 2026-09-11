import { PanelLeft } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import { modGlyph } from "@/lib/shortcuts/platform";
import { cn } from "@/lib/utils";

export function SidebarToggle({ className }: { className?: string }) {
  const { open, toggleSidebar } = useSidebar();
  const label = open ? "Hide sidebar" : "Show sidebar";
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label={label}
      title={`${label} (${modGlyph}B)`}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--sb-hover)] hover:text-foreground [-webkit-app-region:no-drag]",
        className,
      )}
    >
      <PanelLeft className="size-4" />
    </button>
  );
}

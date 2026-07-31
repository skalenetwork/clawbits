import {
  ArrowReloadHorizontalIcon,
  BarChartIcon,
  Coins01Icon,
  EraserIcon,
  HelpCircleIcon,
  PlayCircleIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import type { HugeiconsIconProps } from "@hugeicons/react";

import { Icon } from "@/components/Icon";
import type { AdminCommandKind } from "@/lib/adminCommands";
import { cn } from "@/lib/utils";

type IconSvg = HugeiconsIconProps["icon"];

// Leading tile for a slash command. Hue encodes intent, mirroring the tinted
// tiles the mention popover already uses (`bg-<hue>/15 text-<hue>`):
//   neutral      → create / continue / meta (help)
//   destructive  → destroys the agent session (/reset, /clear)
//   mention-blue → read-only insight (/usage, /cb-usage)
const GLYPH: Record<AdminCommandKind, { icon: IconSvg; tile: string }> = {
  new: { icon: SparklesIcon, tile: "bg-foreground/[0.07] text-foreground/75" },
  start: { icon: PlayCircleIcon, tile: "bg-foreground/[0.07] text-foreground/75" },
  reset: { icon: ArrowReloadHorizontalIcon, tile: "bg-destructive/15 text-destructive" },
  clear: { icon: EraserIcon, tile: "bg-destructive/15 text-destructive" },
  usage: { icon: BarChartIcon, tile: "bg-mention/15 text-mention" },
  "cb-usage": { icon: Coins01Icon, tile: "bg-mention/15 text-mention" },
  help: { icon: HelpCircleIcon, tile: "bg-foreground/[0.07] text-muted-foreground" },
};

/** Tinted, icon-bearing tile for an admin/slash command. Shared by the composer
 *  command menu and the sent-command pill so they read as one language. */
export function AdminCommandGlyph({
  kind,
  className,
}: {
  kind: AdminCommandKind;
  className?: string;
}) {
  const glyph = GLYPH[kind];
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md",
        glyph.tile,
        className,
      )}
    >
      <Icon icon={glyph.icon} className="size-3.5" strokeWidth={1.9} />
    </span>
  );
}

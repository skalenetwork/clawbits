import { useRef, useSyncExternalStore } from "react";

import type { OutlineSection } from "@/lib/channelTimeline";
import { MENU_ITEM, MENU_SURFACE } from "@/lib/menuSurface";
import { cn } from "@/lib/utils";
import type { ViewRow } from "@/lib/viewRow";

const MIN_SECTIONS = 3;

/** The loaded history's human turns as short lines at the pane's left edge, shown while the pointer is over the
 *  chat, the one being read drawn darker. Hovering the lines lists the turns; picking one jumps to it. */
export function ChatOutline({
  sections,
  viewRow,
  onJump,
}: {
  sections: OutlineSection[];
  viewRow: ViewRow;
  onJump: (postId: number) => void;
}) {
  const row = useSyncExternalStore(viewRow.subscribe, viewRow.get);
  const activeRef = useRef<HTMLButtonElement>(null);
  if (sections.length < MIN_SECTIONS) return null;
  const active = sections.findLastIndex((s) => s.index <= row);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-(--header-height) bottom-(--composer-height) z-20 @container">
      <div
        onPointerEnter={() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }}
        className="group/rail pointer-events-auto absolute top-1/2 left-0 hidden max-h-full -translate-y-1/2 flex-col py-2 pr-2 pl-3 opacity-0 transition-opacity duration-150 group-hover/chat:opacity-100 @min-[48rem]:pointer-fine:flex"
      >
        {sections.map((s, i) => (
          <span key={s.postId} aria-hidden className="flex h-2 min-h-0 shrink items-center overflow-hidden">
            <span
              className={cn(
                "h-0.5 rounded-full transition-[width,background-color] duration-150",
                i === active ? "w-4 bg-foreground/60" : "w-2.5 bg-foreground/20",
              )}
            />
          </span>
        ))}
        <nav
          aria-label="Conversation outline"
          className={cn(
            MENU_SURFACE,
            "invisible absolute top-1/2 left-full max-h-[60vh] w-72 -translate-y-1/2 overflow-y-auto opacity-0 transition-[opacity,visibility] duration-150 group-hover/rail:visible group-hover/rail:opacity-100",
          )}
        >
          {sections.map((s, i) => (
            <button
              key={s.postId}
              ref={i === active ? activeRef : undefined}
              type="button"
              onClick={() => { onJump(s.postId); }}
              className={cn(MENU_ITEM, "w-full hover:bg-accent", i !== active && "text-muted-foreground hover:text-foreground")}
            >
              {s.sender && <span className="shrink-0 font-medium">{s.sender}</span>}
              <span className="truncate">{s.text}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

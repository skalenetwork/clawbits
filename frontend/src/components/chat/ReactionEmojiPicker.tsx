import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EmojiPicker as Frimousse } from "frimousse";
import { cn } from "@/lib/utils";
import { MENU_SURFACE } from "@/lib/menuSurface";
import { loadSkinTone } from "@/lib/emoji";

const PANEL_W = 340;
const PANEL_H = 392;
const MARGIN = 8;

/** The bare frimousse emoji grid (search + scrollable list), styled with our
 *  palette. Reused both standalone ({@link ReactionEmojiPicker}) and inline
 *  inside the expandable quick-reaction popover, so the recommended row can
 *  grow straight into the full picker without anything jumping. */
export function EmojiGrid({
  onSelect,
  height,
  autoFocus = true,
}: {
  onSelect: (emoji: string) => void;
  height: number;
  autoFocus?: boolean;
}) {
  return (
    <Frimousse.Root
      skinTone={loadSkinTone()}
      onEmojiSelect={(e) => { onSelect(e.emoji); }}
      columns={9}
      className="isolate flex w-full flex-col"
      style={{ height }}
    >
      <div className="px-1 pb-2">
        <Frimousse.Search
          autoFocus={autoFocus}
          placeholder="Search emoji…"
          className="h-8 w-full rounded-lg border border-border/50 bg-muted/40 px-2.5 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-border focus:bg-muted/60"
        />
      </div>
      <Frimousse.Viewport className="relative flex-1 outline-none">
        <Frimousse.Loading className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
          Loading…
        </Frimousse.Loading>
        <Frimousse.Empty className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
          No emoji found
        </Frimousse.Empty>
        <Frimousse.List
          className="select-none pb-1"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div
                {...props}
                className="bg-popover/80 px-1 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur-sm"
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div {...props} className="scroll-my-1 flex">{children}</div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button
                {...props}
                type="button"
                data-active={emoji.isActive || undefined}
                className="flex size-9 items-center justify-center rounded-lg text-[22px] leading-none transition-colors data-[active]:bg-foreground/[0.08] hover:bg-foreground/[0.08]"
              >
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </Frimousse.Viewport>
    </Frimousse.Root>
  );
}

/** Standalone "any emoji" picker — a portaled, point-anchored {@link EmojiGrid}
 *  on the glass menu surface. Used where there's no persistent recommended row
 *  to grow from (the right-click menu, the mobile action sheet).
 *
 *  `anchor` is a viewport point; the panel opens hugging it (above when there's
 *  room, flipping below) and clamped on-screen. Calls `onSelect` with the bare
 *  emoji char; `onClose` fires on outside-click / Escape. */
export function ReactionEmojiPicker({
  anchor,
  onSelect,
  onClose,
}: {
  anchor: { x: number; y: number };
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const left = Math.max(
      MARGIN,
      Math.min(anchor.x - 24, window.innerWidth - PANEL_W - MARGIN),
    );
    const above = anchor.y - PANEL_H - 10;
    const top =
      above >= MARGIN
        ? above
        : Math.max(MARGIN, Math.min(anchor.y + 12, window.innerHeight - PANEL_H - MARGIN));
    setPos({ left, top });
  }, [anchor.x, anchor.y]);

  // Dismiss on outside pointerdown or Escape (NOT scroll — the grid scrolls
  // internally and the panel is fixed-positioned).
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node | null)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const id = window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointer, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Pick an emoji"
      style={{
        position: "fixed",
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: PANEL_W,
        zIndex: 60,
      }}
      className={cn(MENU_SURFACE, "overflow-hidden duration-100 animate-in fade-in-0 zoom-in-95")}
    >
      <EmojiGrid height={PANEL_H} onSelect={onSelect} />
    </div>,
    document.body,
  );
}

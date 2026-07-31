import { useEffect, useRef, useState } from "react";
import { EmojiPicker as Frimousse, useSkinTone, type Emoji } from "frimousse";
import { Icon } from "@/components/Icon";
import { HappyIcon } from "@hugeicons/core-free-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { loadSkinTone, saveSkinTone, type SkinTone } from "@/lib/emoji";

/** Footer pill that cycles skin tone on click and notifies the parent so
 *  the choice can be persisted. Lives inside the picker root so the
 *  ``useSkinTone`` hook has the context it needs. */
function SkinToneFooter({ onChange }: { onChange: (t: SkinTone) => void }) {
  const [tone, setTone, variations] = useSkinTone();
  const current = variations.find((v) => v.skinTone === tone) ?? variations[0];
  return (
    <div className="flex items-center justify-between border-t border-border/40 px-2 py-1.5">
      <span className="text-[10px] text-muted-foreground/80">
        Press <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">↵</kbd> to insert
      </span>
      <button
        type="button"
        aria-label="Change skin tone"
        onClick={() => {
          const idx = variations.findIndex((v) => v.skinTone === tone);
          const next = variations[(idx + 1) % variations.length]!;
          setTone(next.skinTone);
          onChange(next.skinTone);
        }}
        className="flex size-6 items-center justify-center rounded-md text-base leading-none transition-colors hover:bg-muted"
      >
        {current?.emoji ?? "👋"}
      </button>
    </div>
  );
}

/** Trigger button + popover containing a headless frimousse picker styled
 *  with our Tailwind palette. Calls ``onSelect`` with the bare emoji char
 *  on every pick. Persists the user's last-used skin tone via localStorage.
 *
 *  Pass ``compact`` for the composer's in-capsule action row (size-7 /
 *  size-4 icon - matches the row's 28px ghost-button rhythm). The default
 *  sizing matches the older inline-action context. */
export function EmojiPickerButton({
  onSelect,
  compact = false,
}: {
  onSelect: (emoji: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [skinTone, setSkinToneState] = useState<SkinTone>(() => loadSkinTone());
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleSelect = (e: Emoji) => {
    onSelect(e.emoji);
    setOpen(false);
  };

  return (
    <div className="relative">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={triggerRef}
              type="button"
              aria-label="Insert emoji"
              aria-expanded={open}
              tabIndex={-1}
              onClick={() => { setOpen((v) => !v); }}
              className={
                compact
                  ? "flex size-7 items-center justify-center rounded-lg text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
                  : "flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              }
            >
              <Icon icon={HappyIcon} className={compact ? "size-4" : "size-5"}/>
            </button>
          }
        />
        <TooltipContent side="top" sideOffset={6} className="text-xs">Emoji</TooltipContent>
      </Tooltip>

      {open && (
        <div
          ref={popoverRef}
          className="absolute bottom-full right-0 z-30 mb-2 w-[368px] overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-xl backdrop-blur-xl supports-[backdrop-filter]:bg-background/90"
        >
          <Frimousse.Root
            skinTone={skinTone}
            onEmojiSelect={handleSelect}
            columns={9}
            className="isolate flex h-[360px] w-full flex-col"
          >
            <div className="border-b border-border/40 p-2">
              <Frimousse.Search
                autoFocus
                placeholder="Search emoji…"
                className="h-8 w-full rounded-md border border-border/50 bg-muted/40 px-2.5 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-border focus:bg-muted/60"
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
                className="select-none px-1.5 pb-2"
                components={{
                  CategoryHeader: ({ category, ...props }) => (
                    <div
                      {...props}
                      className="bg-background/95 px-1.5 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur-sm"
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
                      className="flex size-9 items-center justify-center rounded-md text-[24px] leading-none transition-colors data-[active]:bg-muted hover:bg-muted"
                    >
                      {emoji.emoji}
                    </button>
                  ),
                }}
              />
            </Frimousse.Viewport>
            <SkinToneFooter onChange={(t) => { setSkinToneState(t); saveSkinTone(t); }}/>
          </Frimousse.Root>
        </div>
      )}
    </div>
  );
}

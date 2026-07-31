import { useCallback, useRef } from "react";

export interface LongPressHandlers {
  /** Marks the element as a long-press target so index.css can suppress native
   *  text-selection + the iOS callout/share menu on coarse pointers (a
   *  press-and-hold should open our action sheet, not select a word). Stamped
   *  here so every useLongPress consumer is covered with no per-call-site CSS. */
  "data-longpress": "";
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

/**
 * Press-and-hold detector for TOUCH pointers only — mouse and pen are ignored,
 * so desktop keeps its hover affordances untouched. Fires `onLongPress` after
 * `delay` ms of holding still; cancels the moment the finger moves past
 * `moveTolerance` so it never hijacks a scroll, and suppresses the synthesized
 * context menu that follows a successful long-press.
 *
 * Spread the returned handlers onto the pressable element:
 *   <div {...useLongPress(() => setMenuOpen(true))} />
 */
export function useLongPress(
  onLongPress: () => void,
  {
    delay = 450,
    moveTolerance = 10,
  }: { delay?: number; moveTolerance?: number } = {},
): LongPressHandlers {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  return {
    "data-longpress": "",
    onPointerDown: (e) => {
      if (e.pointerType !== "touch") return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        timer.current = null;
        onLongPress();
      }, delay);
    },
    onPointerMove: (e) => {
      const o = origin.current;
      if (!o) return;
      if (
        Math.abs(e.clientX - o.x) > moveTolerance ||
        Math.abs(e.clientY - o.y) > moveTolerance
      ) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e) => {
      // Only swallow the context menu when WE handled the long-press, so
      // desktop right-click (mouse → never fires our timer) is unaffected.
      if (fired.current) e.preventDefault();
    },
  };
}

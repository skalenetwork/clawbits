import { useCallback, useEffect, useRef, useState } from "react";

interface UseChannelDragDropOptions {
  /** Called with the dropped files. Wires straight into
   *  ``useChannelAttachments.addFiles`` — same pipeline as the picker. */
  onDrop: (files: File[]) => void;
}

interface UseChannelDragDropResult {
  /** True from ``dragenter`` until ``drop`` (or last ``dragleave`` for
   *  this drag session). Drives the overlay component. */
  isDragging: boolean;
}

/**
 * Window-level drag-and-drop for chat attachments.
 *
 * The two non-obvious things this hook handles:
 *
 * 1. ``dragleave`` fires every time the cursor moves between child
 *    elements during a drag — naive ``onDragLeave={hide}`` toggles the
 *    overlay on/off rapidly. We instead keep a *counter* of pending
 *    ``dragenter`` events and only consider the drag finished when the
 *    counter returns to zero. Slack, Discord, and Notion all use the
 *    same trick.
 *
 * 2. Browsers fire drag events for many things that aren't files
 *    (text selections, images dragged from another tab). We filter to
 *    actual file drags by checking ``dataTransfer.types.includes("Files")``
 *    so the overlay doesn't flash on harmless interactions.
 *
 * ``preventDefault`` on ``dragover`` is essential — without it the browser
 * refuses to accept the drop and shows a "not allowed" cursor instead.
 */
export function useChannelDragDrop({
  onDrop,
}: UseChannelDragDropOptions): UseChannelDragDropResult {
  const [isDragging, setIsDragging] = useState(false);
  const enterCountRef = useRef(0);
  // Keep the callback in a ref so re-renders don't churn the listeners.
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  const hasFiles = useCallback((dt: DataTransfer | null) => {
    if (!dt) return false;
    // ``types`` is a DOMStringList-like — works with .includes in all
    // current browsers (Chrome/Edge/Safari/Firefox 2020+).
    for (const t of dt.types) if (t === "Files") return true;
    return false;
  }, []);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      enterCountRef.current += 1;
      if (enterCountRef.current === 1) setIsDragging(true);
    };

    const onDragOver = (e: DragEvent) => {
      // MUST preventDefault here for the drop to be accepted by the
      // browser. Without it, the drop event never fires.
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      // Set the visual indicator so the OS shows the "copy" cursor.
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      enterCountRef.current = Math.max(0, enterCountRef.current - 1);
      if (enterCountRef.current === 0) setIsDragging(false);
    };

    const onDropHandler = (e: DragEvent) => {
      // Always preventDefault on drop — even if no files, otherwise the
      // browser may navigate away from the app if a URL was dropped.
      e.preventDefault();
      enterCountRef.current = 0;
      setIsDragging(false);
      if (!e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onDropRef.current(files);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDropHandler);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDropHandler);
    };
  }, [hasFiles]);

  return { isDragging };
}

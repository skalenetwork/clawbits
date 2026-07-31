/**
 * Auto-size a same-origin sandboxed iframe to its content. Works because the
 * frame is sandboxed with ``allow-same-origin`` but WITHOUT ``allow-scripts``
 * — no script can run inside, while the parent may read ``contentDocument``.
 * Measures on load (double-rAF for late layout: fonts, images) and keeps a
 * parent-realm ResizeObserver on the frame's body.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const MIN_HEIGHT = 120;

export function useIframeAutoHeight() {
  const ref = useRef<HTMLIFrameElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);

  const measure = useCallback(() => {
    const doc = ref.current?.contentDocument;
    const h = doc?.documentElement.scrollHeight ?? 0;
    if (h > 0) setHeight(Math.max(MIN_HEIGHT, h));
  }, []);

  const onLoad = useCallback(() => {
    measure();
    requestAnimationFrame(() => {
      requestAnimationFrame(measure);
    });
    const body = ref.current?.contentDocument?.body;
    observerRef.current?.disconnect();
    if (body && typeof ResizeObserver !== "undefined") {
      // A parent-realm observer can watch a same-origin frame's body; wrapped
      // defensively in case a browser disagrees.
      try {
        const observer = new ResizeObserver(measure);
        observer.observe(body);
        observerRef.current = observer;
      } catch {
        observerRef.current = null;
      }
    }
  }, [measure]);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
    },
    [],
  );

  return { ref, height, onLoad };
}

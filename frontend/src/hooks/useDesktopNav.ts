import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  isDesktop,
  listenForNotificationActivation,
  listenForOpenChannel,
} from "@/lib/desktop";

/**
 * Wires the native View menu (Back / Forward / Reload) and Cmd+[/]
 * shortcuts to React Router navigation. The keyboard shortcuts also fire
 * in the browser build — harmless extra affordance.
 *
 * Also subscribes to `desktop://open-channel` so Window → Recent menu
 * clicks navigate to the right route via react-router (rather than a
 * full window.location swap that would drop component state), and to
 * `clawbits://notification-activated` so clicking a native notification lands
 * on the channel it came from.
 */
export function useDesktopNav() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isDesktop) return;
    let dispose: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<string>("desktop://nav", (event) => {
        if (event.payload === "back") void navigate(-1);
        else if (event.payload === "forward") void navigate(1);
        else if (event.payload === "reload") window.location.reload();
      });
      dispose = unlisten;
    })();
    return () => { dispose?.(); };
  }, [navigate]);

  useEffect(() => {
    if (!isDesktop) return;
    let dispose: (() => void) | undefined;
    void (async () => {
      dispose = await listenForOpenChannel((path) => { void navigate(path); });
    })();
    return () => { dispose?.(); };
  }, [navigate]);

  useEffect(() => {
    if (!isDesktop) return;
    let dispose: (() => void) | undefined;
    void (async () => {
      dispose = await listenForNotificationActivation((path) => {
        void navigate(path);
      });
    })();
    return () => { dispose?.(); };
  }, [navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "[") { e.preventDefault(); void navigate(-1); }
      else if (e.key === "]") { e.preventDefault(); void navigate(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [navigate]);
}

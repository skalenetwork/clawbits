import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { checkForUpdate, isDesktop, relaunchApp, type Update } from "@/lib/desktop";
import { toast } from "@/lib/toast";

/**
 * Owns the desktop auto-update lifecycle so the UI (UpdateBanner, a macOS menu
 * item) can stay declarative. On the desktop shell it polls the configured
 * updater endpoint on launch and every 4h; when a newer signed release is
 * found it advances a small state machine that the banner renders:
 *
 *   idle -> available -> downloading -> ready -> (relaunch)
 *                     \-> error (retryable)
 *
 * Background failures stay silent (network blips, bad signatures, the empty
 * dev/staging endpoints) - only user-initiated actions surface errors. On web
 * everything is a no-op, except the ``?forceUpdate=`` preview hook below.
 */

/** Matches the previous toast cadence. */
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Single snoozed version; a newer release clears it implicitly (value !== new). */
const SNOOZE_KEY = "fc_update_snoozed_version";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  info: UpdateInfo | null;
  /** 0..1 while downloading; 0 otherwise. */
  progress: number;
  /** Human-readable message, set only in the "error" state. */
  error: string | null;
  /** Download + stage the available update. */
  install: () => void;
  /** Relaunch into the staged update. */
  restart: () => void;
  /** Manually re-check (wired to the macOS "Check for Updates" menu item). */
  recheck: () => void;
  /** Snooze the current version until a newer one ships. */
  dismiss: () => void;
}

const UpdateContext = createContext<UpdateState | null>(null);

function isSnoozed(version: string): boolean {
  try {
    return window.localStorage.getItem(SNOOZE_KEY) === version;
  } catch {
    return false;
  }
}

function snooze(version: string): void {
  try {
    window.localStorage.setItem(SNOOZE_KEY, version);
  } catch {
    /* ignore - storage quota / private mode */
  }
}

/**
 * Off-desktop preview escape hatch: ``?forceUpdate=available`` (or
 * ``=downloading`` / ``=ready`` / ``=error``) renders the banner on the web dev
 * server so every state can be screenshotted without cutting a release. Returns
 * null in the normal case, leaving the real lifecycle in charge.
 */
function readForcedStatus(): UpdateStatus | null {
  if (typeof window === "undefined") return null;
  try {
    const qs = new URLSearchParams(window.location.search);
    const v = qs.get("forceUpdate") ?? window.localStorage.getItem("fc_update_force");
    if (v && ["available", "downloading", "ready", "error"].includes(v)) {
      return v as UpdateStatus;
    }
    return null;
  } catch {
    return null;
  }
}

const PREVIEW_INFO: UpdateInfo = {
  version: "0.5.1",
  currentVersion: "0.5.0",
  date: new Date().toISOString(),
  body: "- Faster channel switching\n- Crisper desktop notifications\n- **New:** Check for Updates lives in the app menu",
};

export function UpdateProvider({ children }: { children: ReactNode }) {
  const forced = readForcedStatus();

  const [status, setStatus] = useState<UpdateStatus>(forced ?? "idle");
  const [info, setInfo] = useState(forced ? PREVIEW_INFO : null);
  const [progress, setProgress] = useState(forced === "downloading" ? 0.62 : 0);
  const [error, setError] = useState(
    forced === "error" ? "Network error while downloading." : null,
  );

  // The live updater handle. Held in a ref so its Rust-side resource survives
  // between check, download, and relaunch without re-rendering on assignment.
  const updateRef = useRef<Update | null>(null);
  // Mirror of status readable inside timers/listeners without stale closures.
  const statusRef = useRef<UpdateStatus>(status);
  const applyStatus = useCallback((s: UpdateStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const runCheck = useCallback(
    async (manual: boolean) => {
      if (!isDesktop) {
        if (manual) toast.message("Updates are only available in the desktop app.");
        return;
      }
      // Never interrupt an in-flight download or a staged update.
      if (!manual && (statusRef.current === "downloading" || statusRef.current === "ready")) {
        return;
      }
      if (manual) applyStatus("checking");
      try {
        const upd = await checkForUpdate();
        if (upd) {
          updateRef.current = upd;
          const next: UpdateInfo = {
            version: upd.version,
            currentVersion: upd.currentVersion,
            date: upd.date,
            body: upd.body,
          };
          // Background checks respect the snooze; a manual check always shows.
          if (!manual && isSnoozed(next.version)) {
            applyStatus("idle");
            return;
          }
          setInfo(next);
          setError(null);
          setProgress(0);
          applyStatus("available");
        } else {
          updateRef.current = null;
          applyStatus("idle");
          if (manual) toast.success("You're on the latest version.");
        }
      } catch {
        // Background failures stay silent so we never pester the user.
        applyStatus("idle");
        if (manual) toast.error("Couldn't check for updates. Please try again.");
      }
    },
    [applyStatus],
  );

  const install = useCallback(async () => {
    setError(null);

    // Web / forced-preview: no real handle, so animate the flow for demos and
    // screenshots (Install -> progress -> Restart) entirely client-side.
    if (!isDesktop || !updateRef.current) {
      applyStatus("downloading");
      setProgress(0);
      await new Promise<void>((resolve) => {
        let p = 0;
        const id = window.setInterval(() => {
          p += 0.08;
          if (p >= 1) {
            setProgress(1);
            window.clearInterval(id);
            resolve();
          } else {
            setProgress(p);
          }
        }, 80);
      });
      applyStatus("ready");
      return;
    }

    applyStatus("downloading");
    setProgress(0);
    let downloaded = 0;
    let total = 0;
    try {
      await updateRef.current.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            setProgress(0);
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress(total > 0 ? Math.min(1, downloaded / total) : 0);
            break;
          case "Finished":
            setProgress(1);
            break;
        }
      });
      applyStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed.");
      applyStatus("error");
    }
  }, [applyStatus]);

  const restart = useCallback(async () => {
    if (!isDesktop) {
      // Demo: loop back so the preview is repeatable.
      applyStatus("idle");
      return;
    }
    try {
      await relaunchApp();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't restart to apply the update.");
      applyStatus("error");
    }
  }, [applyStatus]);

  const recheck = useCallback(() => {
    void runCheck(true);
  }, [runCheck]);

  const dismiss = useCallback(() => {
    if (info) snooze(info.version);
    applyStatus("idle");
  }, [info, applyStatus]);

  // Poll on launch + every 4h. Skipped in forced-preview and on web.
  useEffect(() => {
    if (forced || !isDesktop) return;
    void runCheck(false);
    const id = window.setInterval(() => {
      void runCheck(false);
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [forced, runCheck]);

  // Manual trigger from the macOS app menu ("Check for Updates...").
  useEffect(() => {
    if (forced || !isDesktop) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("desktop://check-update", () => {
        void runCheck(true);
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [forced, runCheck]);

  const value: UpdateState = {
    status,
    info,
    progress,
    error,
    install: () => {
      void install();
    },
    restart: () => {
      void restart();
    },
    recheck,
    dismiss,
  };

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- hook must co-locate with provider
export function useUpdate(): UpdateState {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate must be used within UpdateProvider");
  return ctx;
}

import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Download01Icon,
  RocketIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import { useUpdate, type UpdateStatus } from "@/context/UpdateContext";
import { cn } from "@/lib/utils";

const HEADER_ICON: Record<Exclude<UpdateStatus, "idle" | "checking">, typeof RocketIcon> = {
  available: RocketIcon,
  downloading: Download01Icon,
  ready: CheckmarkCircle02Icon,
  error: AlertCircleIcon,
};

const TITLE: Record<Exclude<UpdateStatus, "idle" | "checking">, string> = {
  available: "Update available",
  downloading: "Updating Clawbits",
  ready: "Update ready",
  error: "Update failed",
};

/**
 * Auto-update banner pinned to the sidebar footer. Pure consumer of
 * ``useUpdate()`` - hidden unless there's something to act on. Two-step flow:
 * "Install update" downloads with a live progress bar, then the button becomes
 * "Restart now" so the user picks when to relaunch.
 */
export function UpdateBanner() {
  const { status, info, progress, error, install, restart, dismiss } = useUpdate();

  if (status === "idle" || status === "checking" || !info) return null;

  const pct = Math.round(progress * 100);
  const dismissible = status === "available" || status === "error";

  return (
    <div
      className={cn(
        // pointer-events-auto + backdrop-blur: it shares the sidebar's
        // floating footer slot (see DesktopShell), so it must catch its own
        // clicks and frost the list rows that scroll beneath its tint.
        "pointer-events-auto rounded-xl border p-2.5 text-sm backdrop-blur-xl",
        status === "error"
          ? "border-destructive/40 bg-destructive/[0.06]"
          : status === "ready"
            ? "border-emerald-500/40 bg-emerald-500/[0.07]"
            : "border-primary/30 bg-primary/[0.06]",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          icon={HEADER_ICON[status]}
          className={cn(
            "mt-0.5 size-4 shrink-0",
            status === "error"
              ? "text-destructive"
              : status === "ready"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-primary",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-tight text-foreground">{TITLE[status]}</div>
          <div className="truncate text-xs text-muted-foreground">
            {status === "downloading"
              ? pct >= 100
                ? "Installing…"
                : `Downloading ${String(pct)}%`
              : `Version ${info.version}`}
          </div>
        </div>
        {dismissible && (
          <button
            type="button"
            onClick={dismiss}
            title="Dismiss"
            className="-m-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Icon icon={Cancel01Icon} className="size-3.5" />
          </button>
        )}
      </div>

      {status === "downloading" && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
            style={{ width: `${String(Math.max(4, pct))}%` }}
          />
        </div>
      )}

      {status === "error" && error && (
        <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{error}</p>
      )}

      {status !== "downloading" && (
        <div className="mt-2.5 flex items-center gap-2">
          {status === "available" && (
            <Button size="sm" className="flex-1" onClick={() => { install(); }}>
              Install update
            </Button>
          )}
          {status === "ready" && (
            <Button size="sm" className="flex-1" onClick={() => { restart(); }}>
              Restart now
            </Button>
          )}
          {status === "error" && (
            <Button size="sm" variant="secondary" className="flex-1" onClick={() => { install(); }}>
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

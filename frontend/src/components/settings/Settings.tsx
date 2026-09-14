import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReefHost } from "@/lib/api";
import { TONE_FILL, type StatusTone } from "@/lib/status";
import { cn } from "@/lib/utils";

const ROW =
  "relative flex min-h-13 w-full items-center gap-4 px-4 py-3 text-left not-first:before:absolute not-first:before:inset-x-4 not-first:before:top-0 not-first:before:h-px not-first:before:bg-foreground/8";
const PRESSABLE = "outline-none transition-colors first:rounded-t-[14px] last:rounded-b-[14px]";
const TITLE = "block text-sm font-medium text-foreground";

const STATUS_DOT: Record<StatusTone, string> = { ...TONE_FILL, idle: "border border-muted-foreground" };

interface StatusLook {
  tone: StatusTone;
  label: string;
}

const REEF_STATE: Record<string, StatusLook> = {
  running: { tone: "ok", label: "Running" },
  pending: { tone: "idle", label: "Starting" },
  stopped: { tone: "idle", label: "Stopped" },
  failed: { tone: "bad", label: "Failed" },
};

const REEF_HEALTH: Record<ReefHost["health"], StatusLook> = {
  live: { tone: "ok", label: "Live" },
  stale: { tone: "warn", label: "Stale" },
  failing: { tone: "bad", label: "Failing" },
};

export function SettingsPage({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-7 pb-16 md:pt-6">
      {children}
    </div>
  );
}

export function SettingsSection({
  label,
  aside,
  footer,
  stack,
  children,
}: {
  label?: ReactNode;
  aside?: ReactNode;
  footer?: ReactNode;
  stack?: boolean;
  children: ReactNode;
}) {
  return (
    <section>
      {label != null && (
        <div className="flex items-baseline justify-between gap-3 px-3 pb-2 text-[13px] text-muted-foreground">
          <h2 className="font-medium">{label}</h2>
          {aside != null && <div className="font-normal">{aside}</div>}
        </div>
      )}
      <div className={stack ? "flex flex-col gap-2" : "rounded-[14px] bg-card"}>{children}</div>
      {footer != null && (
        <div className="px-3 pt-2 text-[12.5px] text-muted-foreground">{footer}</div>
      )}
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  error,
  leading,
  control,
  htmlFor,
  onClick,
  to,
  replace,
  selected,
  expanded,
}: {
  title: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  leading?: ReactNode;
  control?: ReactNode;
  htmlFor?: string;
  onClick?: () => void;
  to?: string;
  replace?: boolean;
  selected?: boolean;
  expanded?: boolean;
}) {
  const body = (
    <>
      {leading != null && (
        <span className="flex min-h-8 min-w-8 shrink-0 items-center justify-center">{leading}</span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-x-4 gap-y-2 max-sm:flex-wrap">
        <span className="min-w-0 flex-1 max-sm:basis-[calc(100%-3rem)]">
          {htmlFor ? (
            <label htmlFor={htmlFor} className={TITLE}>
              {title}
            </label>
          ) : to ? (
            <Link
              to={to}
              replace={replace}
              aria-current={selected}
              className={cn(TITLE, "outline-none after:absolute after:inset-0")}
            >
              {title}
            </Link>
          ) : (
            <span className={TITLE}>{title}</span>
          )}
          {description != null && (
            <span className="block text-[13px] text-muted-foreground">{description}</span>
          )}
          {error != null && (
            <span className="mt-1 block font-mono text-[12.5px] text-destructive wrap-anywhere">
              {error}
            </span>
          )}
        </span>
        {control != null && (
          <span className="relative flex shrink-0 items-center gap-2">{control}</span>
        )}
      </span>
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected}
      aria-expanded={expanded}
      className={cn(
        ROW,
        PRESSABLE,
        "cursor-pointer hover:bg-foreground/4 focus-visible:bg-foreground/4",
        selected && "bg-foreground/8 hover:bg-foreground/8",
      )}
    >
      {body}
    </button>
  ) : (
    <div
      className={cn(
        ROW,
        to && [PRESSABLE, "has-[a:hover]:bg-foreground/4 has-[a:focus-visible]:bg-foreground/4"],
        selected && "bg-foreground/8 has-[a:hover]:bg-foreground/8",
      )}
    >
      {body}
    </div>
  );
}

export function SettingsRowSkeleton({
  leading = true,
  description = true,
}: {
  leading?: boolean;
  description?: boolean;
}) {
  return (
    <SettingsRow
      leading={leading ? <Skeleton className="size-8 rounded-lg" /> : undefined}
      title={<Skeleton className="h-3.5 w-40 rounded" />}
      description={description ? <Skeleton className="mt-1.5 h-3 w-56 rounded" /> : undefined}
    />
  );
}

export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: StatusTone;
  label?: string;
  className?: string;
}) {
  return (
    <span
      role={label == null ? "presentation" : "img"}
      aria-label={label}
      title={label}
      className={cn("size-2.5 shrink-0 rounded-full", STATUS_DOT[tone], className)}
    />
  );
}

export function SettingsStatus({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <StatusDot tone={tone} className="size-[7px]" />
      {children}
    </span>
  );
}

export function ReefState({ state }: { state: string }) {
  const look = REEF_STATE[state];
  return <SettingsStatus tone={look?.tone ?? "idle"}>{look?.label ?? state}</SettingsStatus>;
}

export function ReefHealth({ health }: { health: ReefHost["health"] }) {
  const { tone, label } = REEF_HEALTH[health];
  return <StatusDot tone={tone} label={label} />;
}

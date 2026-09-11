import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReefHost } from "@/lib/api";
import { cn } from "@/lib/utils";

const ROW =
  "relative flex min-h-13 w-full items-center gap-4 px-4 py-3 text-left not-first:before:absolute not-first:before:inset-x-4 not-first:before:top-0 not-first:before:h-px not-first:before:bg-foreground/8";
const PRESSABLE = "outline-none transition-colors first:rounded-t-[14px] last:rounded-b-[14px]";
const TITLE = "block text-sm font-medium text-foreground";

const STATUS_DOT = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  idle: "border border-muted-foreground",
} as const;

const REEF_HEALTH = {
  live: { tone: "ok", label: "Live", halo: "ring-emerald-500/20" },
  stale: { tone: "warn", label: "Stale", halo: "ring-amber-500/20" },
  failing: { tone: "bad", label: "Failing", halo: "ring-destructive/20" },
} as const satisfies Record<ReefHost["health"], { tone: keyof typeof STATUS_DOT; label: string; halo: string }>;

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
  children,
}: {
  label?: ReactNode;
  aside?: ReactNode;
  footer?: ReactNode;
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
      <div className="rounded-[14px] bg-card">{children}</div>
      {footer != null && (
        <div className="px-3 pt-2 text-[12.5px] text-muted-foreground">
          {footer}
        </div>
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
}: {
  title: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  leading?: ReactNode;
  control?: ReactNode;
  htmlFor?: string;
  onClick?: () => void;
  /** The title links here and its hit area covers the row; the control stays
   *  above it, so a menu in it is never nested in the link. */
  to?: string;
}) {
  const body = (
    <>
      {leading != null && (
        <span className="flex min-h-8 min-w-8 shrink-0 items-center justify-center">
          {leading}
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-x-4 gap-y-2 max-sm:flex-wrap">
        <span className="min-w-0 flex-1 max-sm:basis-[calc(100%-3rem)]">
          {htmlFor ? (
            <label htmlFor={htmlFor} className={TITLE}>
              {title}
            </label>
          ) : to ? (
            <Link to={to} className={cn(TITLE, "outline-none after:absolute after:inset-0")}>
              {title}
            </Link>
          ) : (
            <span className={TITLE}>{title}</span>
          )}
          {description != null && (
            <span className="block text-[13px] text-muted-foreground">
              {description}
            </span>
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
      className={cn(ROW, PRESSABLE, "cursor-pointer hover:bg-foreground/4 focus-visible:bg-foreground/4")}
    >
      {body}
    </button>
  ) : (
    <div
      className={cn(
        ROW,
        to && [PRESSABLE, "has-[a:hover]:bg-foreground/4 has-[a:focus-visible]:bg-foreground/4"],
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

export function SettingsStatus({
  tone,
  children,
}: {
  tone: keyof typeof STATUS_DOT;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <span className={cn("size-[7px] shrink-0 rounded-full", STATUS_DOT[tone])} />
      {children}
    </span>
  );
}

export function ReefHealth({ health }: { health: ReefHost["health"] }) {
  const { tone, label, halo } = REEF_HEALTH[health];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("size-2.5 shrink-0 rounded-full ring-4", STATUS_DOT[tone], halo)}
    />
  );
}

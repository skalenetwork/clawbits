import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReefHost } from "@/lib/api";
import { TONE_FILL, type Pill, type StatusTone } from "@/lib/status";
import { cn } from "@/lib/utils";

const ROW =
  "relative flex min-h-13 w-full items-center gap-4 px-4 py-3 text-left not-first:before:absolute not-first:before:inset-x-4 not-first:before:top-0 not-first:before:h-px not-first:before:bg-foreground/8";
const PRESSABLE = "outline-none transition-colors first:rounded-t-[14px] last:rounded-b-[14px]";
const TITLE = "block text-sm font-medium text-foreground";
const TILE_TITLE = "block truncate text-sm font-medium";

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
  // A row that reports an expanded state gets the disclosure chevron after its control.
  const chevron =
    expanded == null ? null : (
      <span className="disclosure-chevron inline-flex text-muted-foreground" data-open={expanded}>
        <ChevronDown className="size-4" />
      </span>
    );
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
        {(control != null || chevron != null) && (
          <span className="relative flex shrink-0 items-center gap-2">
            {control}
            {chevron}
          </span>
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

/** The settings card for an entity: one stretched link over a filled tile, with a muted note above a pill on the
 *  right. `end` takes the last slot (a status dot, a ··· menu); with `endOnHover` it covers the note and pill only
 *  while the tile is hovered or focused, and keeps its own column wherever there is no fine pointer to hover with. */
export function SettingsTile({
  leading,
  title,
  href,
  subtitle,
  aside,
  pill,
  end,
  endOnHover = false,
  className,
}: {
  leading: ReactNode;
  title: ReactNode;
  href?: string;
  subtitle?: ReactNode;
  aside?: string | false | null;
  pill?: Pill | null;
  end?: ReactNode;
  endOnHover?: boolean;
  className?: string;
}) {
  const reveal = endOnHover && end != null;
  return (
    <div
      className={cn(
        "group relative grid min-h-16 items-center gap-x-[11px] rounded-[14px] bg-card p-3 has-[a:hover]:bg-foreground/4 has-[a:focus-visible]:bg-foreground/4",
        end == null
          ? "grid-cols-[40px_minmax(6rem,1fr)_minmax(0,auto)]"
          : "grid-cols-[40px_minmax(6rem,1fr)_minmax(0,auto)_auto]",
        reveal && "pointer-fine:grid-cols-[40px_minmax(6rem,1fr)_minmax(0,auto)]",
        className,
      )}
    >
      {leading}
      <span className="min-w-0">
        {href ? (
          <Link to={href} className={cn(TILE_TITLE, "outline-none after:absolute after:inset-0")}>
            {title}
          </Link>
        ) : (
          <span className={TILE_TITLE}>{title}</span>
        )}
        {subtitle != null && (
          <span className="block truncate text-[13px] text-muted-foreground tabular-nums">{subtitle}</span>
        )}
      </span>
      <span
        className={cn(
          "flex min-w-0 flex-col items-end gap-1 text-[13px] text-muted-foreground",
          reveal &&
            "pointer-fine:group-hover:invisible pointer-fine:group-focus-within:invisible pointer-fine:group-has-[[aria-expanded=true]]:invisible",
        )}
      >
        {aside && <span className="max-w-full truncate">{aside}</span>}
        {pill && <TilePill {...pill} />}
      </span>
      {end != null && (
        <span
          className={cn(
            "relative flex items-center justify-center gap-1.5",
            reveal
              ? "pointer-fine:invisible pointer-fine:absolute pointer-fine:top-1/2 pointer-fine:right-3 pointer-fine:-translate-y-1/2 pointer-fine:group-hover:visible pointer-fine:group-focus-within:visible pointer-fine:group-has-[[aria-expanded=true]]:visible"
              : "w-7 pointer-coarse:w-auto",
          )}
        >
          {end}
        </span>
      )}
    </div>
  );
}

export function TilePill({ label, bad }: Pill) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full bg-foreground/6 px-2 py-0.5 text-[12px] whitespace-nowrap",
        bad ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

export function TileGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 sm:grid-cols-2">{children}</div>;
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

/**
 * Schedule model for automations: the OpenClaw cron `schedule` object in its
 * three kinds (`every` / `cron` / `at`) plus the humanizers the UI needs.
 * Only `reported_state.nextRunAtMs` is agent-reported truth — anything the
 * client derives from a schedule must be labeled as such where it renders
 * (see docs/protocol/AUTOMATIONS_UI_PLAN.md).
 */
import { Cron } from "croner";
import cronstrue from "cronstrue";

export interface EverySchedule {
  kind: "every";
  everyMs: number;
}
export interface CronKindSchedule {
  kind: "cron";
  expr: string;
  tz?: string;
}
export interface AtSchedule {
  kind: "at";
  /** Epoch milliseconds *in the client model only*. The wire form is a string —
   *  see {@link scheduleToSpec}. Kept numeric here because every consumer
   *  compares it against `Date.now()` or feeds it to a date picker. */
  at: number;
}
export type Schedule = EverySchedule | CronKindSchedule | AtSchedule;

/** The operator's IANA timezone — printed beside schedules, never assumed. */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Defensive parse of a stored `spec.schedule` into a typed {@link Schedule}. */
export function parseSchedule(raw: unknown): Schedule | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.kind === "every" && typeof s.everyMs === "number" && s.everyMs > 0) {
    return { kind: "every", everyMs: s.everyMs };
  }
  if (s.kind === "cron" && typeof s.expr === "string" && s.expr.trim() !== "") {
    return {
      kind: "cron",
      expr: s.expr.trim(),
      tz: typeof s.tz === "string" && s.tz ? s.tz : undefined,
    };
  }
  if (s.kind === "at") {
    // Accepts every form an `at` spec has been stored in: a legacy epoch number
    // (what this app used to serialize), an epoch-millisecond digit string, and
    // the ISO-8601 string OpenClaw's cron schema actually wants. Without the
    // string cases a normalized automation would silently render as "no
    // schedule" and the composer would offer to overwrite it.
    const at = parseAtValue(s.at);
    if (at !== null) return { kind: "at", at };
  }
  return null;
}

/** Epoch milliseconds from an epoch number, an epoch digit string, or ISO-8601. */
function parseAtValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/** Serialize back to the OpenClaw `schedule` payload shape. */
export function scheduleToSpec(schedule: Schedule): Record<string, unknown> {
  switch (schedule.kind) {
    case "every":
      return { kind: "every", everyMs: schedule.everyMs };
    case "cron":
      return schedule.tz
        ? { kind: "cron", expr: schedule.expr, tz: schedule.tz }
        : { kind: "cron", expr: schedule.expr };
    case "at":
      // ISO-8601, not the epoch number this app models internally. OpenClaw's
      // cron schema declares `at` as a non-empty STRING inside a closed object
      // (packages/gateway-protocol/src/schema/cron.ts), so a numeric `at` is
      // rejected outright: the automation reports sync_status="failed" and the
      // one-shot never fires. The plugin normalizes defensively too, for specs
      // this app authored before the fix.
      return { kind: "at", at: new Date(schedule.at).toISOString() };
  }
}

/** "day" / "2 days" / "45 min" / "6 hours" — the body of "Every …". Only
 *  promotes to a larger unit when the interval divides into it cleanly, so a
 *  100-minute interval reads "100 min", never "1.6666666666666667 hours". */
export function humanizeEvery(ms: number): string {
  if (ms < 60_000) {
    const sec = Math.max(1, Math.round(ms / 1000));
    return sec === 1 ? "second" : `${String(sec)} sec`;
  }
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  if (ms % WEEK === 0) {
    const weeks = ms / WEEK;
    return weeks === 1 ? "week" : `${String(weeks)} weeks`;
  }
  if (ms % DAY === 0) {
    const days = ms / DAY;
    return days === 1 ? "day" : `${String(days)} days`;
  }
  if (ms % HOUR === 0) {
    const hours = ms / HOUR;
    return hours === 1 ? "hour" : `${String(hours)} hours`;
  }
  const minutes = Math.round(ms / MIN);
  return minutes === 1 ? "minute" : `${String(minutes)} min`;
}

/** Plain-English cron echo (cronstrue), or null when it doesn't parse. */
export function cronEcho(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  try {
    return cronstrue.toString(trimmed, { use24HourTimeFormat: false });
  } catch {
    return null;
  }
}

/** Whether croner (what the runtime uses to fire) accepts the expression. */
export function cronValid(expr: string, tz?: string): boolean {
  try {
    // No callback → just a parsed pattern holder, no timer is started.
    new Cron(expr.trim(), tz ? { timezone: tz } : undefined);
    return true;
  } catch {
    return false;
  }
}

/** "Mon, Jul 6 · 9:00 AM" in the given tz (defaults to the local one). */
export function formatInstant(ms: number, tz?: string): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
  return `${date} · ${time}`;
}

/**
 * One human sentence for a schedule: "Every day", "At 9:00 AM, Monday through
 * Friday", "Once on Mon, Jul 6 · 9:00 AM". Falls back to the raw cron
 * expression when cronstrue can't read it.
 */
export function describeSchedule(schedule: Schedule | null): string {
  if (!schedule) return "—";
  switch (schedule.kind) {
    case "every":
      return `Every ${humanizeEvery(schedule.everyMs)}`;
    case "cron": {
      const base = cronEcho(schedule.expr) ?? schedule.expr;
      // Clock times are meaningless without their frame: name the schedule's
      // tz whenever it isn't the reader's own.
      return schedule.tz && schedule.tz !== localTimezone()
        ? `${base} (${schedule.tz})`
        : base;
    }
    case "at":
      return `Once on ${formatInstant(schedule.at)}`;
  }
}

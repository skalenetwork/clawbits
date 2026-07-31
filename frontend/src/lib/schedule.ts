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
  if (s.kind === "at" && typeof s.at === "number" && Number.isFinite(s.at)) {
    return { kind: "at", at: s.at };
  }
  return null;
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
      return { kind: "at", at: schedule.at };
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

export type StatusTone = "ok" | "info" | "warn" | "bad" | "idle";

export const TONE_FILL = {
  ok: "bg-emerald-500",
  info: "bg-blue-500",
  warn: "bg-amber-500",
  bad: "bg-destructive",
} as const satisfies Record<Exclude<StatusTone, "idle">, string>;

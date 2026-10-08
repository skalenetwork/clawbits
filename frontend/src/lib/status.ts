export type StatusTone = "ok" | "info" | "warn" | "bad" | "idle";

/** A pill names its state in words; only a failure changes the ink, never the fill. */
export interface Pill {
  label: string;
  bad?: boolean;
}

export const TONE_FILL = {
  ok: "bg-emerald-500",
  info: "bg-blue-500",
  warn: "bg-amber-500",
  bad: "bg-destructive",
} as const satisfies Record<Exclude<StatusTone, "idle">, string>;

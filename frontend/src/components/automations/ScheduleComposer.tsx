import {useMemo, useState} from "react";
import {Input} from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {SCHEDULE_UNITS, decomposeInterval, intervalToMs} from "@/lib/automations";
import {cronEcho, cronValid, localTimezone, type Schedule} from "@/lib/schedule";
import {cn} from "@/lib/utils";

/**
 * The schedule composer: preset chips first, a segmented `every | cron | once`
 * control behind "Custom". No natural-language parsing — presets plus a live
 * plain-English echo (cronstrue) deliver the "it compiles before your eyes"
 * trust without a parser that half-works on recurrence.
 */

const HOUR_MS = 3_600_000;

interface Preset {
    id: string;
    label: string;
    make: (tz: string) => Schedule;
    /** A preset chip reads as LOCAL time, so a stored cron only matches when
     *  its tz is the viewer's — a foreign-tz "0 9 * * *" must render as
     *  Custom, never as a local "Daily · 9:00". */
    matches: (s: Schedule, localTz: string) => boolean;
}

function cronMatches(s: Schedule, expr: string, localTz: string): boolean {
    return s.kind === "cron" && s.expr === expr && (s.tz ?? localTz) === localTz;
}

const PRESETS: Preset[] = [
    {
        id: "hourly",
        label: "Hourly",
        make: () => ({kind: "every", everyMs: HOUR_MS}),
        matches: (s) => s.kind === "every" && s.everyMs === HOUR_MS,
    },
    {
        id: "daily",
        label: "Daily · 9:00",
        make: (tz) => ({kind: "cron", expr: "0 9 * * *", tz}),
        matches: (s, localTz) => cronMatches(s, "0 9 * * *", localTz),
    },
    {
        id: "weekdays",
        label: "Weekdays · 9:00",
        make: (tz) => ({kind: "cron", expr: "0 9 * * 1-5", tz}),
        matches: (s, localTz) => cronMatches(s, "0 9 * * 1-5", localTz),
    },
    {
        id: "weekly",
        label: "Weekly · Mon",
        make: (tz) => ({kind: "cron", expr: "0 9 * * 1", tz}),
        matches: (s, localTz) => cronMatches(s, "0 9 * * 1", localTz),
    },
];

type CustomMode = "every" | "cron" | "once";

/** "YYYY-MM-DDTHH:mm" for a datetime-local input, in local time. */
function toLocalInputValue(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Chip({selected, onClick, children}: {
    selected: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={selected}
            className={cn(
                "rounded-full px-3.5 py-2 text-sm font-medium transition-colors active:scale-[0.97]",
                selected
                    ? "bg-primary text-primary-foreground"
                    : "bg-input/50 text-muted-foreground hover:bg-input/80 hover:text-foreground",
            )}
        >
            {children}
        </button>
    );
}

export function ScheduleComposer({value, now, onChange}: {
    value: Schedule;
    /** Ticking clock from the parent (render purity + one instant per form). */
    now: number;
    /** `valid=false` while a custom cron doesn't parse or a one-shot is in the
     *  past — the Forge disables save on it. */
    onChange: (schedule: Schedule, valid: boolean) => void;
}) {
    const localTz = useMemo(() => localTimezone(), []);
    // A stored cron keeps ITS tz through every edit — the viewer's tz applies
    // only when a schedule is first authored here. Silently rewriting a
    // foreign tz would shift the fire time by the tz delta.
    const tz = value.kind === "cron" && value.tz ? value.tz : localTz;
    const matchedPreset = PRESETS.find(p => p.matches(value, localTz));
    // "Custom" stays selected once chosen, even if the drafted value happens to
    // equal a preset — flipping the chip under the user reads as a glitch.
    const [customPinned, setCustomPinned] = useState(matchedPreset == null);
    const isCustom = customPinned || matchedPreset == null;
    const mode: CustomMode =
        value.kind === "at" ? "once" : value.kind === "every" ? "every" : "cron";

    // Raw cron text lives locally so invalid intermediate states stay visible
    // while the parent only ever holds the last structured value.
    const [cronText, setCronText] = useState(value.kind === "cron" ? value.expr : "0 9 * * 1-5");
    const cronOk = cronValid(cronText);
    const echo = cronEcho(cronText);

    const interval = decomposeInterval(value.kind === "every" ? value.everyMs : HOUR_MS);
    const atMs = value.kind === "at" ? value.at : now + HOUR_MS;

    const setMode = (next: CustomMode) => {
        setCustomPinned(true);
        if (next === "every") {
            onChange({kind: "every", everyMs: intervalToMs(interval.value, interval.unitId)}, true);
        } else if (next === "cron") {
            // Derive the text from the CURRENT value (not the possibly-stale
            // local draft) so toggling into cron view never rewrites the
            // schedule under the user.
            const expr = value.kind === "cron" ? value.expr : cronText;
            setCronText(expr);
            onChange({kind: "cron", expr, tz}, cronValid(expr));
        } else {
            const at = Math.ceil((Date.now() + HOUR_MS) / 60_000) * 60_000;
            onChange({kind: "at", at}, true);
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
                {PRESETS.map(p => (
                    <Chip
                        key={p.id}
                        selected={matchedPreset != null && !isCustom && matchedPreset.id === p.id}
                        onClick={() => {
                            setCustomPinned(false);
                            // A preset chip is an explicit re-authoring in the
                            // viewer's OWN time — "Daily · 9:00" means local 9:00.
                            onChange(p.make(localTz), true);
                        }}
                    >
                        {p.label}
                    </Chip>
                ))}
                <Chip
                    selected={isCustom}
                    onClick={() => {
                        // Entering Custom starts on the simplest editor; if the
                        // user is already in it, re-clicking must not reset
                        // their draft.
                        if (!isCustom) setMode("every");
                    }}
                >
                    Custom
                </Chip>
            </div>

            {/* `inert` keeps the collapsed controls out of the tab order. */}
            <div className="disclosure" data-open={isCustom ? "true" : "false"} inert={!isCustom}>
                <div className="disclosure-inner">
                    <div className="space-y-3 pt-1">
                        <div className="inline-flex rounded-lg bg-input/50 p-0.5">
                            {([
                                ["every", "Interval"],
                                ["cron", "Cron"],
                                ["once", "Once"],
                            ] as const).map(([m, label]) => (
                                <button
                                    key={m}
                                    type="button"
                                    aria-pressed={mode === m}
                                    onClick={() => { setMode(m); }}
                                    className={cn(
                                        "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                                        mode === m
                                            ? "bg-card text-foreground"
                                            : "text-muted-foreground hover:text-foreground",
                                    )}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {mode === "every" && (
                            <div className="flex gap-2">
                                <Input
                                    type="number"
                                    min={1}
                                    aria-label="Run every"
                                    className="w-20"
                                    value={interval.value}
                                    onChange={(e) => {
                                        const v = Math.max(1, Number(e.target.value) || 1);
                                        onChange({kind: "every", everyMs: intervalToMs(v, interval.unitId)}, true);
                                    }}
                                />
                                <Select
                                    value={interval.unitId}
                                    onValueChange={(unitId: string | null) => {
                                        onChange({kind: "every", everyMs: intervalToMs(interval.value, unitId ?? "hours")}, true);
                                    }}
                                    items={Object.fromEntries(SCHEDULE_UNITS.map(u => [u.id, u.label]))}
                                >
                                    <SelectTrigger className="flex-1" aria-label="Interval unit">
                                        <SelectValue/>
                                    </SelectTrigger>
                                    <SelectContent>
                                        {SCHEDULE_UNITS.map(u => (
                                            <SelectItem key={u.id} value={u.id}>{u.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        )}

                        {mode === "cron" && (
                            <div className="space-y-1.5">
                                <Input
                                    aria-label="Cron expression"
                                    className="font-mono"
                                    placeholder="0 9 * * 1-5"
                                    value={cronText}
                                    aria-invalid={!cronOk || undefined}
                                    onChange={(e) => {
                                        const expr = e.target.value;
                                        setCronText(expr);
                                        onChange({kind: "cron", expr: expr.trim(), tz}, cronValid(expr));
                                    }}
                                />
                                <p className={cn("text-xs", cronOk ? "text-muted-foreground" : "text-destructive")}>
                                    {cronOk
                                        ? `${echo ?? cronText} · ${tz}`
                                        : "Unreadable cron expression"}
                                </p>
                            </div>
                        )}

                        {mode === "once" && (
                            <div className="space-y-1.5">
                                <Input
                                    type="datetime-local"
                                    aria-label="Run at"
                                    value={toLocalInputValue(atMs)}
                                    aria-invalid={atMs <= now || undefined}
                                    onChange={(e) => {
                                        const at = new Date(e.target.value).getTime();
                                        if (Number.isFinite(at)) onChange({kind: "at", at}, at > Date.now());
                                    }}
                                />
                                <p className="text-xs text-muted-foreground">
                                    {atMs > now
                                        ? "Runs once, then disarms."
                                        : "Pick a moment in the future."}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

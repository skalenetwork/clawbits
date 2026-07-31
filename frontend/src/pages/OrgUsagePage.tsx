import {useMemo, useRef, useState, useEffect} from "react";
import {useQuery} from "@tanstack/react-query";
import {
    ChartHistogramIcon as UsageIcon,
    InformationCircleIcon as Info,
    CpuIcon as Cpu,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {PageHeader} from "@/components/PageHeader";
import {EmptyState} from "@/components/EmptyState";
import {Skeleton} from "@/components/ui/skeleton";
import {AgentAvatarWithPresence} from "@/components/AgentStatus";
import {useAuth} from "@/context/AuthContext";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {
    getAgents, getOrgUsage,
    type AgentUser, type OrgUsageAgentRow, type UsageDay, type UsageRange, type UsageTotals,
} from "@/lib/api";
import {agentDisplay} from "@/lib/agentDisplay";
import {providerBrand} from "@/components/new-agent/brands";
import {queryKeys} from "@/lib/queryKeys";
import {cn} from "@/lib/utils";
import {
    exactFmt, formatCost, formatTokens, headlineTokens, shortModel,
} from "@/lib/usageFormat";
import {AgentUsageDrawer} from "@/components/usage/AgentUsageDrawer";

// ---------------------------------------------------------------------------
// The usage ledger. Calm, editorial take on a usage dashboard: serif KPI
// numerals (the app's hero signature), one hairline-divided stat band, a
// stacked daily trend, and two ledgers (agents / models). All charts are
// hand-rolled SVG — no chart lib — and every categorical color below was
// validated (CVD + contrast) against the app's real light/dark surfaces.
// ---------------------------------------------------------------------------

const RANGES: {key: UsageRange; label: string; days: number | null}[] = [
    {key: "day", label: "Today", days: 1},
    {key: "week", label: "7 days", days: 7},
    {key: "month", label: "30 days", days: 30},
    {key: "all", label: "All time", days: null},
];

// Validated categorical slots (dataviz six-checks, run against --card in both
// modes). Assigned to agents in stable roster order — color follows the
// entity, never its rank. "Other" is a reserved neutral, not a 6th hue.
const SERIES_LIGHT = ["#2a78d6", "#008300", "#e87ba4", "#eda100", "#1baf7a"];
const SERIES_DARK = ["#3987e5", "#008300", "#d55181", "#c98500", "#199e70"];
const OTHER_LIGHT = "#a8a29e";
const OTHER_DARK = "#6b6963";
const MAX_SERIES = 4;

function useIsDark(): boolean {
    const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
    useEffect(() => {
        const observer = new MutationObserver(() => {
            setDark(document.documentElement.classList.contains("dark"));
        });
        observer.observe(document.documentElement, {attributes: true, attributeFilter: ["class"]});
        return () => { observer.disconnect(); };
    }, []);
    return dark;
}

// Trailing-window helpers for period-over-period deltas + run-rate. Dates are
// UTC calendar days, matching the server's daily buckets and `fillDays`.
function utcDayOffset(offset: number): string {
    const today = new Date();
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
    return d.toISOString().slice(0, 10);
}

/** `n` ISO day strings ending `endOffset` days before today (oldest first). */
function trailingDates(n: number, endOffset: number): string[] {
    return Array.from({length: n}, (_, i) => utcDayOffset(endOffset + (n - 1 - i)));
}

function sumWindow(byDate: Map<string, UsageDay>, dates: string[]): UsageTotals {
    const acc: UsageTotals = {
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
        cache_write_tokens: 0, cost_usd: null, call_count: 0,
    };
    for (const date of dates) {
        const day = byDate.get(date);
        if (!day) continue;
        acc.input_tokens += day.input_tokens;
        acc.output_tokens += day.output_tokens;
        acc.cache_read_tokens += day.cache_read_tokens;
        acc.cache_write_tokens += day.cache_write_tokens;
        acc.call_count += day.call_count;
        if (day.cost_usd != null) acc.cost_usd = (acc.cost_usd ?? 0) + day.cost_usd;
    }
    return acc;
}

/** Percent change vs the prior window; null when there's no baseline. */
function pctDelta(cur: number, prev: number): number | null {
    if (prev <= 0) return null;
    return ((cur - prev) / prev) * 100;
}

/** Zero-filled UTC day window for the chart. `daily` only carries days that
 *  have data; the window is derived from the range (or the data span on
 *  "all") so quiet days render as honest gaps, not missing columns. */
function fillDays(daily: UsageDay[], range: UsageRange): UsageDay[] {
    const byDate = new Map(daily.map((d) => [d.date, d]));
    const zero = (date: string): UsageDay => ({
        date,
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
        cache_write_tokens: 0, cost_usd: null, call_count: 0,
    });
    const utcDay = utcDayOffset;
    const windowDays = RANGES.find((r) => r.key === range)?.days ?? null;
    let dates: string[];
    if (windowDays != null) {
        dates = Array.from({length: windowDays}, (_, i) => utcDay(windowDays - 1 - i));
    } else {
        // All time: span from the first recorded day through today.
        const first = daily[0]?.date ?? utcDay(0);
        const start = new Date(`${first}T00:00:00Z`).getTime();
        const end = new Date(`${utcDay(0)}T00:00:00Z`).getTime();
        const n = Math.min(365, Math.round((end - start) / 86_400_000) + 1);
        dates = Array.from({length: n}, (_, i) =>
            new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
    }
    return dates.map((date) => byDate.get(date) ?? zero(date));
}

function dayLabel(date: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    return d.toLocaleDateString("en", {month: "short", day: "numeric", timeZone: "UTC"});
}

// ---------------------------------------------------------------------------
// Stat band — one card, hairline dividers, serif numerals.
// ---------------------------------------------------------------------------

/** Period-over-period change pill. Up is tinted warm (more spend = mild
 *  caution), down cool — advisory only, never a judgement of "good/bad". */
function DeltaChip({pct, title}: {pct: number; title: string}) {
    const up = pct >= 0;
    return (
        <span
            title={title}
            className={cn(
                "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums",
                up
                    ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
            )}
        >
            <span aria-hidden>{up ? "↑" : "↓"}</span>
            {Math.abs(pct).toFixed(0)}%
        </span>
    );
}

function Stat({label, value, sub, delta, deltaTitle}: {
    label: string; value: string; sub?: string | null;
    delta?: number | null; deltaTitle?: string;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-0.5 px-4 py-3.5">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-[1.6rem] font-semibold leading-9 tabular-nums tracking-tight text-foreground">
                    {value}
                </span>
                {delta != null && <DeltaChip pct={delta} title={deltaTitle ?? ""}/>}
            </span>
            {sub && <span className="truncate text-xs tabular-nums text-muted-foreground">{sub}</span>}
        </div>
    );
}

/** One thin stacked share strip per card (the "referral visits" pattern) —
 *  rows below stay quiet because the distribution is told exactly once. */
function DistributionBar({segments}: {segments: {key: string; color: string; value: number}[]}) {
    const visible = segments.filter((s) => s.value > 0);
    const total = visible.reduce((acc, s) => acc + s.value, 0);
    if (total <= 0 || visible.length === 0) return null;
    return (
        <div className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full">
            {visible.map((s) => (
                <div
                    key={s.key}
                    className="h-full rounded-full"
                    style={{width: `${String((s.value / total) * 100)}%`, minWidth: 3, background: s.color}}
                />
            ))}
        </div>
    );
}

// Solid accents for the models strip, keyed by provider (brand hues from the
// tile gradients). Fixed brand colors, valid on both surfaces.
const PROVIDER_ACCENT: Record<string, string> = {
    anthropic: "#D97757",
    openai: "#10A37F",
    google: "#4285F4",
    gemini: "#4285F4",
};

// Shared column template for the agents table: name | trend | calls | cost |
// share | tokens. Declared once so the header row and data rows can't drift.
const AGENT_GRID =
    "grid grid-cols-[minmax(0,1fr)_5rem_3.25rem_3.75rem_2.75rem_5rem] items-center gap-x-3";

// ---------------------------------------------------------------------------
// Trend chart — stacked daily bars (owner: top agents + Other), SVG.
// ---------------------------------------------------------------------------

interface TrendSeries {
    key: string;
    name: string;
    color: string;
}

interface TrendDatum {
    day: UsageDay;
    /** Per-series headline tokens, in series order. */
    values: number[];
}

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
    const ref = useRef<T>(null);
    const [width, setWidth] = useState(0);
    useEffect(() => {
        if (!ref.current) return;
        const el = ref.current;
        const observer = new ResizeObserver((entries) => {
            setWidth(entries[0]?.contentRect.width ?? 0);
        });
        observer.observe(el);
        return () => { observer.disconnect(); };
    }, []);
    return [ref, width];
}

/** Rounded-top column path (4px data-end, square baseline). */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
    const rr = Math.min(r, w / 2, h);
    const f = (v: number) => v.toFixed(2);
    return [
        `M${f(x)},${f(y + h)}`,
        `L${f(x)},${f(y + rr)}`,
        `Q${f(x)},${f(y)} ${f(x + rr)},${f(y)}`,
        `L${f(x + w - rr)},${f(y)}`,
        `Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + rr)}`,
        `L${f(x + w)},${f(y + h)}`,
        "Z",
    ].join(" ");
}

function TrendChart({data, series, isDark}: {
    data: TrendDatum[];
    series: TrendSeries[];
    isDark: boolean;
}) {
    const [wrapRef, width] = useElementWidth<HTMLDivElement>();
    const [hover, setHover] = useState<number | null>(null);
    const height = 208;
    const pad = {top: 8, right: 8, bottom: 22, left: 8};
    const plotW = Math.max(0, width - pad.left - pad.right);
    const plotH = height - pad.top - pad.bottom;
    const n = data.length;
    const maxTotal = Math.max(1, ...data.map((d) => d.values.reduce((a, b) => a + b, 0)));
    const gap = n > 45 ? 1 : 2;
    const barW = n > 0 ? Math.max(2, (plotW - gap * (n - 1)) / n) : 0;
    const x = (i: number) => pad.left + i * (barW + gap);
    const yScale = (v: number) => (v / maxTotal) * plotH;

    // Sparse x labels: first, last, and evenly spaced ticks in between.
    const tickEvery = n <= 8 ? 1 : Math.ceil(n / 6);
    const gridColor = isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.06)";
    const hoverIdx = hover;
    const hovered = hoverIdx != null ? data[hoverIdx] : null;

    return (
        <div ref={wrapRef} className="relative">
            {width > 0 && (
                <svg width={width} height={height} role="img" aria-label="Daily token usage">
                    {/* Recessive gridlines at 1/2 and full max, with value labels. */}
                    {[0.5, 1].map((f) => (
                        <g key={f}>
                            <line
                                x1={pad.left} x2={width - pad.right}
                                y1={pad.top + plotH - f * plotH} y2={pad.top + plotH - f * plotH}
                                stroke={gridColor}
                            />
                            <text
                                x={pad.left} y={pad.top + plotH - f * plotH + 12}
                                className="fill-muted-foreground/50 text-[10px] tabular-nums"
                            >
                                {formatTokens(maxTotal * f)}
                            </text>
                        </g>
                    ))}
                    <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotH} y2={pad.top + plotH} stroke={gridColor}/>

                    {data.map((d, i) => {
                        const total = d.values.reduce((a, b) => a + b, 0);
                        if (total === 0) {
                            // Honest empty day: a faint 2px baseline stub.
                            return (
                                <rect
                                    key={d.day.date}
                                    x={x(i)} y={pad.top + plotH - 2}
                                    width={barW} height={2} rx={1}
                                    fill={gridColor}
                                />
                            );
                        }
                        // Exact value heights, stacked bottom-up; the 2px surface
                        // gaps are painted OVER the boundaries afterwards so small
                        // values never lose height to the spacer. Top segment gets
                        // the rounded data-end.
                        const segments = d.values
                            .map((v, si) => ({v, si}))
                            .filter((s) => s.v > 0);
                        let cursor = pad.top + plotH;
                        const boundaries: number[] = [];
                        const marks = segments.map((s, order) => {
                            const h = Math.max(1.5, yScale(s.v));
                            const isTop = order === segments.length - 1;
                            const yTop = cursor - h;
                            const el = isTop ? (
                                <path
                                    key={s.si}
                                    d={topRoundedRect(x(i), yTop, barW, h, 3)}
                                    fill={series[s.si]?.color}
                                />
                            ) : (
                                <rect
                                    key={s.si}
                                    x={x(i)} y={yTop} width={barW} height={h}
                                    fill={series[s.si]?.color}
                                />
                            );
                            if (!isTop) boundaries.push(yTop);
                            cursor = yTop;
                            return el;
                        });
                        return (
                            <g
                                key={d.day.date}
                                className="usage-grow"
                                style={{transformOrigin: `0 ${String(pad.top + plotH)}px`}}
                                opacity={hover == null || hover === i ? 1 : 0.35}
                            >
                                {marks}
                                {boundaries.map((by) => (
                                    <rect
                                        key={by}
                                        x={x(i) - 0.5} y={by - 1}
                                        width={barW + 1} height={2}
                                        style={{fill: "var(--card)"}}
                                    />
                                ))}
                            </g>
                        );
                    })}

                    {/* X labels — sparse, recessive. */}
                    {data.map((d, i) =>
                        i % tickEvery === 0 || i === n - 1 ? (
                            <text
                                key={`t-${d.day.date}`}
                                x={x(i) + barW / 2} y={height - 6}
                                textAnchor="middle"
                                className="fill-muted-foreground/60 text-[10px]"
                            >
                                {dayLabel(d.day.date)}
                            </text>
                        ) : null,
                    )}

                    {/* Hover hit targets — full column height, wider than the mark. */}
                    {data.map((d, i) => (
                        <rect
                            key={`h-${d.day.date}`}
                            x={x(i) - gap / 2} y={pad.top}
                            width={barW + gap} height={plotH}
                            fill="transparent"
                            onMouseEnter={() => { setHover(i); }}
                            onMouseLeave={() => { setHover(null); }}
                        />
                    ))}
                </svg>
            )}

            {/* Tooltip: date, total, per-series breakdown, cost. */}
            {hovered && hoverIdx != null && (
                <div
                    className="pointer-events-none absolute z-10 w-52 rounded-xl border border-border/70 bg-popover p-3 shadow-lg"
                    style={{
                        left: Math.min(Math.max(0, x(hoverIdx) + barW / 2 - 104), Math.max(0, width - 208)),
                        top: -8,
                        transform: "translateY(-100%)",
                    }}
                >
                    <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-medium">{dayLabel(hovered.day.date)}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                            {formatTokens(headlineTokens(hovered.day))} tokens
                        </span>
                    </div>
                    {hovered.values.some((v) => v > 0) && series.length > 1 && (
                        <div className="mt-2 space-y-1">
                            {series.map((s, si) =>
                                (hovered.values[si] ?? 0) > 0 ? (
                                    <div key={s.key} className="flex items-center justify-between gap-2 text-[11px]">
                                        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                                            <span className="size-2 shrink-0 rounded-full" style={{background: s.color}}/>
                                            <span className="truncate">{s.name}</span>
                                        </span>
                                        <span className="tabular-nums">{formatTokens(hovered.values[si] ?? 0)}</span>
                                    </div>
                                ) : null,
                            )}
                        </div>
                    )}
                    <div className="mt-2 flex items-center justify-between border-t border-border/50 pt-1.5 text-[11px] text-muted-foreground">
                        <span>{exactFmt.format(hovered.day.call_count)} {hovered.day.call_count === 1 ? "call" : "calls"}</span>
                        <span className="tabular-nums">{formatCost(hovered.day.cost_usd) ?? "—"}</span>
                    </div>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Sparkline — 2px line + soft area, one hue per agent row.
// ---------------------------------------------------------------------------

function Sparkline({points, color, w = 80, h = 24}: {
    points: number[]; color: string; w?: number; h?: number;
}) {
    const max = Math.max(1, ...points);
    const n = points.length;
    if (n < 2) return <div style={{width: w, height: h}}/>;
    const px = (i: number) => (i / (n - 1)) * (w - 4) + 2;
    const py = (v: number) => h - 3 - (v / max) * (h - 8);
    const path = points.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
    const area = `${path} L${px(n - 1).toFixed(1)},${String(h - 1)} L${px(0).toFixed(1)},${String(h - 1)} Z`;
    const last = points[n - 1] ?? 0;
    return (
        <svg width={w} height={h} className="shrink-0" aria-hidden="true">
            <path d={area} fill={color} opacity={0.12}/>
            <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/>
            {last > 0 && <circle cx={px(n - 1)} cy={py(last)} r={2.5} fill={color}/>}
        </svg>
    );
}

// ---------------------------------------------------------------------------
// Segmented range control.
// ---------------------------------------------------------------------------

function RangeControl({value, onChange}: {value: UsageRange; onChange: (v: UsageRange) => void}) {
    return (
        <div className="inline-flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/40 p-0.5">
            {RANGES.map((o) => (
                <button
                    key={o.key}
                    type="button"
                    onClick={() => { onChange(o.key); }}
                    className={cn(
                        "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
                        o.key === value
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OrgUsagePage() {
    const {activeOrgId} = useAuth();
    const {isOwner} = useActiveOrg();
    const isDark = useIsDark();
    const [range, setRange] = useState<UsageRange>("week");
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

    const usageQuery = useQuery({
        queryKey: activeOrgId
            ? queryKeys.orgUsage(activeOrgId, range, "model")
            : ["org", "none", "usage"],
        queryFn: () => getOrgUsage(activeOrgId ?? "", {range, groupBy: "model"}),
        enabled: Boolean(activeOrgId),
    });
    // Full-history fetch backing the period deltas + recent run-rate. One
    // cached query; skipped on the All tab (no prior period to compare, and the
    // main query already carries the full daily series there).
    const allUsageQuery = useQuery({
        queryKey: activeOrgId
            ? queryKeys.orgUsage(activeOrgId, "all", "agent")
            : ["org", "none", "usageAll"],
        queryFn: () => getOrgUsage(activeOrgId ?? "", {range: "all", groupBy: "agent"}),
        enabled: Boolean(activeOrgId) && range !== "all",
    });
    const agentsQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.agents(activeOrgId) : ["agents", "none"],
        queryFn: () => getAgents(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && isOwner,
    });

    const data = usageQuery.data;
    const agents = useMemo(
        () => agentsQuery.data?.agents ?? [],
        [agentsQuery.data],
    );
    const agentsById = useMemo(
        () => new Map<string, AgentUser>(agents.map((a) => [a.agent_id, a])),
        [agents],
    );

    const days = useMemo(
        () => (data ? fillDays(data.daily, data.range) : []),
        [data],
    );

    // Chart series: the window's top agents by headline tokens, hue-assigned
    // in roster (creation) order so an agent keeps its color across ranges;
    // everything else folds into a neutral "Other".
    const palette = isDark ? SERIES_DARK : SERIES_LIGHT;
    const otherColor = isDark ? OTHER_DARK : OTHER_LIGHT;
    const {series, trend, colorByAgent} = useMemo(() => {
        const paletteAt = (i: number): string => palette[i % palette.length] ?? otherColor;
        const perAgent = data?.per_agent ?? [];
        if (!data || perAgent.length === 0) {
            // Member view (or no per-agent data): one recessive series.
            const single: TrendSeries[] = [{key: "total", name: "Tokens", color: paletteAt(0)}];
            return {
                series: single,
                trend: days.map((day) => ({day, values: [headlineTokens(day)]})),
                colorByAgent: new Map<string, string>(),
            };
        }
        const byUsage = [...perAgent].sort((a, b) => headlineTokens(b) - headlineTokens(a));
        const top = byUsage.slice(0, MAX_SERIES).filter((a) => headlineTokens(a) > 0);
        const rosterIndex = new Map(agents.map((a, i) => [a.agent_id, i]));
        const ordered = [...top].sort(
            (a, b) => (rosterIndex.get(a.agent_id) ?? 999) - (rosterIndex.get(b.agent_id) ?? 999),
        );
        const colorMap = new Map<string, string>();
        const s: TrendSeries[] = ordered.map((a, i) => {
            colorMap.set(a.agent_id, paletteAt(i));
            return {
                key: a.agent_id,
                name: agentDisplay(agentsById.get(a.agent_id) ?? a),
                color: paletteAt(i),
            };
        });
        const topIds = new Set(ordered.map((a) => a.agent_id));
        const hasOther = perAgent.some((a) => !topIds.has(a.agent_id) && headlineTokens(a) > 0);
        if (hasOther) s.push({key: "__other", name: "Other", color: otherColor});
        const t: TrendDatum[] = days.map((day) => {
            const byAgent = day.by_agent ?? {};
            const values = s.map((ser) => {
                if (ser.key === "__other") {
                    return Object.entries(byAgent)
                        .filter(([id]) => !topIds.has(id))
                        .reduce((acc, [, v]) => acc + v, 0);
                }
                return byAgent[ser.key] ?? 0;
            });
            return {day, values};
        });
        return {series: s, trend: t, colorByAgent: colorMap};
    }, [data, days, agents, agentsById, palette, otherColor]);

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    const total = data?.org_total;
    const perAgent = data?.per_agent ?? [];
    const perModel = data?.per_model ?? [];
    const anyUsage = (total?.call_count ?? 0) > 0;
    const cacheHitRate = total && total.input_tokens + total.cache_read_tokens > 0
        ? total.cache_read_tokens / (total.input_tokens + total.cache_read_tokens)
        : null;
    const orgHeadline = total ? headlineTokens(total) : 0;
    const costPerCall = total?.cost_usd != null && total.call_count > 0
        ? total.cost_usd / total.call_count : null;

    // Period-over-period deltas + run-rate, off the full-history daily series
    // (cheap: n ≤ ~365). On the All tab the main query carries `daily`.
    const windowDays = RANGES.find((r) => r.key === range)?.days ?? null;
    const allDaily = range === "all" ? (data?.daily ?? []) : (allUsageQuery.data?.daily ?? []);
    const allByDate = new Map(allDaily.map((d) => [d.date, d]));

    const deltas = total && windowDays != null && allDaily.length > 0
        ? (() => {
            const prev = sumWindow(allByDate, trailingDates(windowDays, windowDays));
            return {
                tokens: pctDelta(headlineTokens(total), headlineTokens(prev)),
                cache: pctDelta(total.cache_read_tokens, prev.cache_read_tokens),
                calls: pctDelta(total.call_count, prev.call_count),
                cost: total.cost_usd != null && prev.cost_usd != null
                    ? pctDelta(total.cost_usd, prev.cost_usd) : null,
            };
        })()
        : null;

    const runRate = (() => {
        if (allDaily.length === 0) return null;
        let tokens = 0, cost = 0, costDays = 0, activeDays = 0;
        for (const date of trailingDates(7, 0)) {
            const day = allByDate.get(date);
            if (!day) continue;
            const h = headlineTokens(day);
            tokens += h;
            if (h > 0 || day.call_count > 0) activeDays += 1;
            if (day.cost_usd != null) { cost += day.cost_usd; costDays += 1; }
        }
        if (activeDays === 0) return null;
        return {tokensPerMonth: (tokens / 7) * 30, costPerMonth: costDays > 0 ? (cost / 7) * 30 : null};
    })();

    const activeAgents = perAgent.filter((a) => a.call_count > 0).length;
    const deltaTitle = range === "day"
        ? "vs yesterday"
        : `vs prior ${RANGES.find((r) => r.key === range)?.label.toLowerCase() ?? "period"}`;

    const sparkFor = (agentId: string): number[] =>
        days.map((d) => d.by_agent?.[agentId] ?? 0);

    return (
        <div className="space-y-4">
            <style>{`
                @keyframes usage-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
                @keyframes usage-scale { from { transform: scaleY(0); } to { transform: scaleY(1); } }
                .usage-section { animation: usage-rise 0.45s cubic-bezier(0.22,1,0.36,1) both; }
                .usage-grow { animation: usage-scale 0.5s cubic-bezier(0.22,1,0.36,1) both; }
                @media (prefers-reduced-motion: reduce) {
                    .usage-section, .usage-grow { animation: none; }
                }
            `}</style>

            <PageHeader icon={UsageIcon} title="Usage" actions={<RangeControl value={range} onChange={setRange}/>}/>

            {usageQuery.isLoading ? (
                <div className="space-y-4">
                    <Skeleton className="h-24 rounded-2xl"/>
                    <Skeleton className="h-64 rounded-2xl"/>
                    <div className="grid gap-4 lg:grid-cols-2">
                        <Skeleton className="h-56 rounded-2xl"/>
                        <Skeleton className="h-56 rounded-2xl"/>
                    </div>
                </div>
            ) : usageQuery.isError ? (
                <EmptyState
                    icon={UsageIcon}
                    title="Couldn't load usage"
                    description={usageQuery.error instanceof Error ? usageQuery.error.message : "Try again shortly."}
                />
            ) : total && (
                <>
                    {/* Stat band — one card, hairline dividers, serif numerals. */}
                    <section className="usage-section grid grid-cols-2 divide-border/50 overflow-hidden rounded-2xl border border-border/60 bg-card max-sm:divide-y sm:grid-cols-4 sm:divide-x">
                        <Stat
                            label="Tokens"
                            value={formatTokens(orgHeadline)}
                            sub={`${formatTokens(total.input_tokens)} in · ${formatTokens(total.output_tokens)} out`}
                            delta={deltas?.tokens}
                            deltaTitle={deltaTitle}
                        />
                        <Stat
                            label="Cache reads"
                            value={formatTokens(total.cache_read_tokens)}
                            sub={cacheHitRate != null
                                ? `${(cacheHitRate * 100).toFixed(0)}% from cache · ${formatTokens(total.cache_write_tokens)} written`
                                : (total.cache_write_tokens > 0 ? `${formatTokens(total.cache_write_tokens)} written` : null)}
                            delta={deltas?.cache}
                            deltaTitle={deltaTitle}
                        />
                        <Stat
                            label="Model calls"
                            value={exactFmt.format(total.call_count)}
                            delta={deltas?.calls}
                            deltaTitle={deltaTitle}
                        />
                        <Stat
                            label="Cost"
                            value={formatCost(total.cost_usd) ?? "—"}
                            sub={total.cost_usd == null
                                ? "no cost reported"
                                : (costPerCall != null ? `${formatCost(costPerCall) ?? ""}/call` : "as reported by agents")}
                            delta={deltas?.cost}
                            deltaTitle={deltaTitle}
                        />
                    </section>

                    {/* Run rate + adoption — one quiet line under the KPIs. */}
                    {anyUsage && (Boolean(runRate) || (isOwner && perAgent.length > 0)) && (
                        <div
                            className="usage-section flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground/80"
                            style={{animationDelay: "30ms"}}
                        >
                            {runRate ? (
                                <span className="tabular-nums">
                                    Run rate ≈ {formatTokens(runRate.tokensPerMonth)} tokens/mo
                                    {runRate.costPerMonth != null ? ` · ${formatCost(runRate.costPerMonth) ?? ""}/mo` : ""}
                                    <span className="text-muted-foreground/50"> · last 7 days</span>
                                </span>
                            ) : <span/>}
                            {isOwner && perAgent.length > 0 && (
                                <span className="tabular-nums">{activeAgents} of {perAgent.length} agents active</span>
                            )}
                        </div>
                    )}

                    {!anyUsage && perAgent.every((a) => !a.reporting) ? (
                        <div className="usage-section" style={{animationDelay: "60ms"}}>
                            <EmptyState
                                icon={UsageIcon}
                                title="No usage reported yet"
                                description="Each agent's plugin reports its own token usage automatically once it's online — numbers land here within a minute of the first model call."
                            />
                        </div>
                    ) : (
                        <>
                            {/* Trend — stacked daily bars. */}
                            <section
                                className="usage-section rounded-2xl border border-border/60 bg-card px-4 pb-3 pt-3.5"
                                style={{animationDelay: "60ms"}}
                            >
                                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                    <h2 className="text-sm font-medium">Daily tokens</h2>
                                    {series.length > 1 && (
                                        <div className="flex flex-wrap items-center gap-3">
                                            {series.map((s) => (
                                                <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                                    <span className="size-2 rounded-full" style={{background: s.color}}/>
                                                    {s.name}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <TrendChart data={trend} series={series} isDark={isDark}/>
                            </section>

                            <div className="grid items-start gap-4 lg:grid-cols-5">
                                {/* Agents table: one distribution strip, then quiet
                                    labeled columns — name | trend | calls | cost |
                                    share | tokens. */}
                                {isOwner && (
                                    <section
                                        className="usage-section rounded-2xl border border-border/60 bg-card lg:col-span-3"
                                        style={{animationDelay: "120ms"}}
                                    >
                                        <h2 className="border-b border-border/50 px-4 py-2.5 text-sm font-medium">Agents</h2>
                                        <div className="px-4 pt-3">
                                            <DistributionBar
                                                segments={perAgent.map((a) => ({
                                                    key: a.agent_id,
                                                    color: colorByAgent.get(a.agent_id) ?? otherColor,
                                                    value: headlineTokens(a),
                                                }))}
                                            />
                                        </div>
                                        <div className={cn(AGENT_GRID, "px-4 pb-1 pt-3 text-[10px] font-medium text-muted-foreground/60")}>
                                            <span>Agent</span>
                                            <span>Trend</span>
                                            <span className="text-right">Calls</span>
                                            <span className="text-right">Cost</span>
                                            <span className="text-right">Share</span>
                                            <span className="text-right">Tokens</span>
                                        </div>
                                        <div className="divide-y divide-border/40 pb-1">
                                            {perAgent.map((row) => (
                                                <AgentTableRow
                                                    key={row.agent_id}
                                                    row={row}
                                                    agent={agentsById.get(row.agent_id)}
                                                    spark={sparkFor(row.agent_id)}
                                                    color={colorByAgent.get(row.agent_id) ?? otherColor}
                                                    share={orgHeadline > 0 ? headlineTokens(row) / orgHeadline : 0}
                                                    onOpen={() => { setSelectedAgentId(row.agent_id); }}
                                                />
                                            ))}
                                        </div>
                                    </section>
                                )}

                                {/* Models ledger. */}
                                <section
                                    className={cn(
                                        "usage-section rounded-2xl border border-border/60 bg-card",
                                        isOwner ? "lg:col-span-2" : "lg:col-span-5",
                                    )}
                                    style={{animationDelay: "180ms"}}
                                >
                                    <h2 className="border-b border-border/50 px-4 py-2.5 text-sm font-medium">Models</h2>
                                    {perModel.length > 0 && (
                                        <div className="px-4 pt-3">
                                            <DistributionBar
                                                segments={perModel.map((m) => ({
                                                    key: `${m.model}:${m.provider ?? ""}`,
                                                    color: PROVIDER_ACCENT[m.provider ?? ""] ?? otherColor,
                                                    value: headlineTokens(m),
                                                }))}
                                            />
                                        </div>
                                    )}
                                    <div className="divide-y divide-border/40 pb-1 pt-1.5">
                                        {perModel.length === 0 ? (
                                            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                                                No model calls in this period.
                                            </p>
                                        ) : perModel.map((m) => {
                                            const modelCost = formatCost(m.cost_usd);
                                            // Usage derives gemini-prefix models as provider
                                            // "google"; the brand registry keys it "gemini".
                                            const brand = providerBrand(
                                                m.provider === "google" ? "gemini" : (m.provider ?? ""),
                                            );
                                            const modelShare = orgHeadline > 0 ? headlineTokens(m) / orgHeadline : 0;
                                            return (
                                            <div key={`${m.model}:${m.provider ?? ""}`} className="flex items-center gap-3 px-4 py-2.5">
                                                <span
                                                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white"
                                                    style={{background: brand.tile}}
                                                >
                                                    {brand.Glyph
                                                        ? <brand.Glyph className="size-4"/>
                                                        : <Icon icon={Cpu} className="size-4 opacity-90"/>}
                                                </span>
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-sm font-medium">{m.model}</div>
                                                    <div className="truncate text-[11px] text-muted-foreground/70">{m.provider ?? "unknown"}</div>
                                                </div>
                                                <div className="shrink-0 text-right">
                                                    <div className="text-sm font-semibold tabular-nums">
                                                        {formatTokens(headlineTokens(m))}
                                                        <span className="ml-1 font-normal text-muted-foreground/70">
                                                            ({(modelShare * 100).toFixed(0)}%)
                                                        </span>
                                                    </div>
                                                    <div className="text-[11px] tabular-nums text-muted-foreground/70">
                                                        {exactFmt.format(m.call_count)} {m.call_count === 1 ? "call" : "calls"}
                                                        {modelCost ? ` · ${modelCost}` : ""}
                                                    </div>
                                                </div>
                                            </div>
                                            );
                                        })}
                                    </div>
                                </section>
                            </div>
                        </>
                    )}

                    <p className="usage-section flex items-start gap-1.5 text-xs text-muted-foreground/80" style={{animationDelay: "240ms"}}>
                        <Icon icon={Info} className="mt-0.5 size-3.5 shrink-0"/>
                        <span>
                            Self-reported by each agent&apos;s plugin — informational only, never used for
                            billing. Turns that deliver no reply may not be counted yet
                            {data.role === "member" ? "; per-agent detail is visible to org owners" : ""}.
                        </span>
                    </p>

                    {isOwner && (
                        <AgentUsageDrawer
                            open={selectedAgentId != null}
                            onOpenChange={(open) => { if (!open) setSelectedAgentId(null); }}
                            orgId={activeOrgId}
                            agentId={selectedAgentId}
                            agent={selectedAgentId ? agentsById.get(selectedAgentId) : undefined}
                            range={range}
                            rangeLabel={RANGES.find((r) => r.key === range)?.label ?? ""}
                            color={selectedAgentId ? (colorByAgent.get(selectedAgentId) ?? otherColor) : otherColor}
                            trend={selectedAgentId ? sparkFor(selectedAgentId) : []}
                            trendLabels={days.map((d) => dayLabel(d.date))}
                        />
                    )}
                </>
            )}
        </div>
    );
}

function AgentTableRow({row, agent, spark, color, share, onOpen}: {
    row: OrgUsageAgentRow;
    agent?: AgentUser;
    spark: number[];
    color: string;
    share: number;
    onOpen?: () => void;
}) {
    const name = agentDisplay(agent ?? row);
    const silent = !row.reporting && row.call_count === 0;
    const cost = formatCost(row.cost_usd);
    const models = row.top_models.slice(0, 2).map(shortModel).join(" · ");

    if (silent) {
        return (
            <div className={cn(AGENT_GRID, "px-4 py-2.5 opacity-55")}>
                <div className="flex min-w-0 items-center gap-2.5">
                    <AgentAvatarWithPresence
                        agentId={row.agent_id}
                        name={name}
                        src={agent?.avatar?.url}
                        size={28}
                        ringClassName="ring-card"
                    />
                    <span className="truncate text-sm font-medium">{name}</span>
                </div>
                <span className="col-span-5 text-right text-xs text-muted-foreground/70">
                    not reporting yet
                </span>
            </div>
        );
    }

    return (
        <button
            type="button"
            onClick={onOpen}
            className={cn(
                AGENT_GRID,
                "w-full px-4 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
            )}
        >
            <div className="flex min-w-0 items-center gap-2.5">
                <AgentAvatarWithPresence
                    agentId={row.agent_id}
                    name={name}
                    src={agent?.avatar?.url}
                    size={28}
                    ringClassName="ring-card"
                />
                <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium leading-tight">{name}</span>
                    {models && (
                        <span className="truncate text-[11px] leading-tight text-muted-foreground/70">{models}</span>
                    )}
                </div>
            </div>
            <Sparkline points={spark} color={color}/>
            <span className="text-right text-xs tabular-nums text-muted-foreground">
                {exactFmt.format(row.call_count)}
            </span>
            <span className="text-right text-xs tabular-nums text-muted-foreground">
                {cost ?? "—"}
            </span>
            <span className="text-right text-xs tabular-nums text-muted-foreground">
                {(share * 100).toFixed(0)}%
            </span>
            <span className="text-right text-sm font-semibold tabular-nums">
                {formatTokens(headlineTokens(row))}
            </span>
        </button>
    );
}

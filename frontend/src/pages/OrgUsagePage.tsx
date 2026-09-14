import {useMemo, useRef, useState, useEffect} from "react";
import {useQuery} from "@tanstack/react-query";
import {ChartHistogramIcon as UsageIcon, CpuIcon as Cpu} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {PageHeader} from "@/components/PageHeader";
import {EmptyState} from "@/components/EmptyState";
import {SettingsPage, SettingsRow, SettingsRowSkeleton, SettingsSection} from "@/components/settings/Settings";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {Skeleton} from "@/components/ui/skeleton";
import {AgentAvatarWithPresence} from "@/components/AgentStatus";
import {useAuth} from "@/context/AuthContext";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {
    getAgents, getOrgUsage,
    type AgentUser, type OrgUsageAgentRow, type UsageDay, type UsageRange, type UsageTotals,
} from "@/lib/api";
import {agentDisplay} from "@/lib/agentDisplay";
import {providerBrand} from "@/lib/brands";
import {queryKeys} from "@/lib/queryKeys";
import {cn} from "@/lib/utils";
import {
    exactFmt, formatCost, formatTokens, headlineTokens, shortModel,
} from "@/lib/usageFormat";
import {AgentUsageDrawer} from "@/components/usage/AgentUsageDrawer";

const RANGES: Record<UsageRange, {label: string; days: number | null}> = {
    day: {label: "Today", days: 1},
    week: {label: "Last 7 days", days: 7},
    month: {label: "Last 30 days", days: 30},
    all: {label: "All time", days: null},
};

// Validated categorical slots (CVD and contrast against --card in both modes).
// Assigned in stable roster order so color follows the agent, never its rank;
// "Other" is a reserved neutral, not a sixth hue.
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

// UTC calendar days, matching the server's daily buckets.
function utcDayOffset(offset: number): string {
    const today = new Date();
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
    return d.toISOString().slice(0, 10);
}

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

function pctDelta(cur: number, prev: number): number | null {
    if (prev <= 0) return null;
    return ((cur - prev) / prev) * 100;
}

// `daily` only carries days with data; zero-fill the window so quiet days
// render as honest gaps instead of missing columns.
function fillDays(daily: UsageDay[], range: UsageRange): UsageDay[] {
    const byDate = new Map(daily.map((d) => [d.date, d]));
    const zero = (date: string): UsageDay => ({
        date,
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
        cache_write_tokens: 0, cost_usd: null, call_count: 0,
    });
    const windowDays = RANGES[range].days;
    let dates: string[];
    if (windowDays != null) {
        dates = Array.from({length: windowDays}, (_, i) => utcDayOffset(windowDays - 1 - i));
    } else {
        const first = daily[0]?.date ?? utcDayOffset(0);
        const start = new Date(`${first}T00:00:00Z`).getTime();
        const end = new Date(`${utcDayOffset(0)}T00:00:00Z`).getTime();
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

function callsLabel(n: number): string {
    return `${exactFmt.format(n)} ${n === 1 ? "call" : "calls"}`;
}

// Up is tinted warm (more spend, mild caution), down cool: advisory, not a verdict.
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
        <div className="flex min-w-0 flex-col gap-0.5">
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

function TokenShare({tokens, total}: {tokens: number; total: number}) {
    return (
        <span className="text-[13px] tabular-nums text-muted-foreground">
            {formatTokens(tokens)} · {total > 0 ? ((tokens / total) * 100).toFixed(0) : 0}%
        </span>
    );
}

interface TrendSeries {
    key: string;
    name: string;
    color: string;
}

interface TrendDatum {
    day: UsageDay;
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
    const tickEvery = n <= 8 ? 1 : Math.ceil(n / 6);
    const gridColor = isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.06)";
    const hovered = hover != null ? data[hover] : null;

    return (
        <div ref={wrapRef} className="relative">
            {width > 0 && (
                <svg width={width} height={height} role="img" aria-label="Daily token usage">
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
                            return (
                                <rect
                                    key={d.day.date}
                                    x={x(i)} y={pad.top + plotH - 2}
                                    width={barW} height={2} rx={1}
                                    fill={gridColor}
                                />
                            );
                        }
                        // Segments stack at exact heights; the 2px gaps are painted over
                        // the boundaries afterwards so small values never lose height.
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
                            <g key={d.day.date} opacity={hover == null || hover === i ? 1 : 0.35}>
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

            {hovered && hover != null && (
                <div
                    className="pointer-events-none absolute z-10 w-52 rounded-xl border border-border/70 bg-popover p-3 shadow-lg"
                    style={{
                        left: Math.min(Math.max(0, x(hover) + barW / 2 - 104), Math.max(0, width - 208)),
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
                        <span>{callsLabel(hovered.day.call_count)}</span>
                        <span className="tabular-nums">{formatCost(hovered.day.cost_usd)}</span>
                    </div>
                </div>
            )}
        </div>
    );
}

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

function AgentRow({row, agent, spark, color, total, onOpen}: {
    row: OrgUsageAgentRow;
    agent?: AgentUser;
    spark: number[];
    color: string;
    total: number;
    onOpen: () => void;
}) {
    const name = agentDisplay(agent ?? row);
    const avatar = <AgentAvatarWithPresence agentId={row.agent_id} name={name} src={agent?.avatar?.url} size={28}/>;
    if (!row.reporting && row.call_count === 0) {
        return <SettingsRow leading={avatar} title={name} description="Not reporting yet"/>;
    }
    return (
        <SettingsRow
            leading={avatar}
            title={name}
            description={[
                callsLabel(row.call_count),
                formatCost(row.cost_usd),
                row.top_models.slice(0, 2).map(shortModel).join(", "),
            ].filter(Boolean).join(" · ")}
            control={
                <>
                    <Sparkline points={spark} color={color}/>
                    <TokenShare tokens={headlineTokens(row)} total={total}/>
                </>
            }
            onClick={onOpen}
        />
    );
}

function UsageSkeleton() {
    return (
        <>
            <SettingsSection>
                <div className="p-4"><Skeleton className="h-[4.5rem] rounded-lg"/></div>
            </SettingsSection>
            <SettingsSection>
                <div className="p-4"><Skeleton className="h-52 rounded-lg"/></div>
            </SettingsSection>
            <SettingsSection>
                {[0, 1, 2].map((i) => <SettingsRowSkeleton key={i}/>)}
            </SettingsSection>
        </>
    );
}

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
    // Full history backs the period deltas and run rate; skipped on All, where
    // there is no prior period and the main query already carries every day.
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

    // Top agents get hues in roster order so each keeps its color across ranges.
    const palette = isDark ? SERIES_DARK : SERIES_LIGHT;
    const otherColor = isDark ? OTHER_DARK : OTHER_LIGHT;
    const {series, trend, colorByAgent} = useMemo(() => {
        const paletteAt = (i: number): string => palette[i % palette.length] ?? otherColor;
        const perAgent = data?.per_agent ?? [];
        if (!data || perAgent.length === 0) {
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

    const windowDays = RANGES[range].days;
    const allDaily = range === "all" ? (data?.daily ?? []) : (allUsageQuery.data?.daily ?? []);
    const allByDate = new Map(allDaily.map((d) => [d.date, d]));

    const deltas = total && windowDays != null && allDaily.length > 0
        ? (() => {
            const prev = sumWindow(allByDate, trailingDates(windowDays, windowDays));
            return {
                title: windowDays === 1 ? "vs yesterday" : `vs prior ${windowDays} days`,
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
    const sparkFor = (agentId: string): number[] =>
        days.map((d) => d.by_agent?.[agentId] ?? 0);
    const disclaimer = `Self-reported by agents and never used for billing. Turns without a reply may not be counted yet.${
        data?.role === "member" ? " Org admins see per-agent detail." : ""}`;

    return (
        <>
            <PageHeader
                icon={UsageIcon}
                title="Usage"
                actions={
                    <Select value={range} onValueChange={(v) => { if (v) setRange(v); }}>
                        <SelectTrigger size="sm" aria-label="Usage range" className="h-7">
                            <SelectValue>{(v: UsageRange) => RANGES[v].label}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {Object.entries(RANGES).map(([value, r]) => (
                                <SelectItem key={value} value={value}>{r.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                }
            />

            <SettingsPage>
                {usageQuery.isLoading ? (
                    <UsageSkeleton/>
                ) : usageQuery.isError ? (
                    <SettingsSection>
                        <SettingsRow
                            title="Couldn't load usage"
                            description="Try again shortly"
                            error={usageQuery.error.message}
                        />
                    </SettingsSection>
                ) : total && (
                    <>
                        <SettingsSection
                            label={RANGES[range].label}
                            aside={anyUsage && runRate ? (
                                <span className="tabular-nums" title="From the last 7 days">
                                    Run rate ≈ {formatTokens(runRate.tokensPerMonth)} tokens/mo
                                    {runRate.costPerMonth != null ? ` · ${formatCost(runRate.costPerMonth) ?? ""}/mo` : ""}
                                </span>
                            ) : null}
                        >
                            <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                                <Stat
                                    label="Tokens"
                                    value={formatTokens(orgHeadline)}
                                    sub={`${formatTokens(total.input_tokens)} in · ${formatTokens(total.output_tokens)} out`}
                                    delta={deltas?.tokens}
                                    deltaTitle={deltas?.title}
                                />
                                <Stat
                                    label="Cache reads"
                                    value={formatTokens(total.cache_read_tokens)}
                                    sub={[
                                        cacheHitRate != null && `${(cacheHitRate * 100).toFixed(0)}% hit`,
                                        total.cache_write_tokens > 0 && `${formatTokens(total.cache_write_tokens)} written`,
                                    ].filter(Boolean).join(" · ")}
                                    delta={deltas?.cache}
                                    deltaTitle={deltas?.title}
                                />
                                <Stat
                                    label="Model calls"
                                    value={exactFmt.format(total.call_count)}
                                    delta={deltas?.calls}
                                    deltaTitle={deltas?.title}
                                />
                                <Stat
                                    label="Cost"
                                    value={formatCost(total.cost_usd) ?? "-"}
                                    sub={total.cost_usd == null
                                        ? "Not reported"
                                        : costPerCall != null ? `${formatCost(costPerCall) ?? ""}/call` : null}
                                    delta={deltas?.cost}
                                    deltaTitle={deltas?.title}
                                />
                            </div>
                        </SettingsSection>

                        {!anyUsage && perAgent.every((a) => !a.reporting) ? (
                            <SettingsSection footer={disclaimer}>
                                <EmptyState
                                    icon={UsageIcon}
                                    title="No usage reported yet"
                                    description="Agents report their own token usage once online, within a minute of the first model call."
                                />
                            </SettingsSection>
                        ) : (
                            <>
                                <SettingsSection
                                    label="Daily tokens"
                                    aside={series.length > 1 ? (
                                        <span className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs">
                                            {series.map((s) => (
                                                <span key={s.key} className="flex items-center gap-1.5">
                                                    <span className="size-2 rounded-full" style={{background: s.color}}/>
                                                    {s.name}
                                                </span>
                                            ))}
                                        </span>
                                    ) : null}
                                >
                                    <div className="px-4 pb-3 pt-4">
                                        <TrendChart data={trend} series={series} isDark={isDark}/>
                                    </div>
                                </SettingsSection>

                                {isOwner && perAgent.length > 0 && (
                                    <SettingsSection
                                        label="Agents"
                                        aside={<span className="tabular-nums">{activeAgents} of {perAgent.length} active</span>}
                                    >
                                        {perAgent.map((row) => (
                                            <AgentRow
                                                key={row.agent_id}
                                                row={row}
                                                agent={agentsById.get(row.agent_id)}
                                                spark={sparkFor(row.agent_id)}
                                                color={colorByAgent.get(row.agent_id) ?? otherColor}
                                                total={orgHeadline}
                                                onOpen={() => { setSelectedAgentId(row.agent_id); }}
                                            />
                                        ))}
                                    </SettingsSection>
                                )}

                                <SettingsSection label="Models" footer={disclaimer}>
                                    {perModel.length === 0 ? (
                                        <p className="px-4 py-4 text-[13px] text-muted-foreground">
                                            No model calls in this period
                                        </p>
                                    ) : perModel.map((m) => {
                                        const brand = providerBrand(m.provider ?? "");
                                        return (
                                            <SettingsRow
                                                key={`${m.model}:${m.provider ?? ""}`}
                                                leading={
                                                    <span
                                                        className="flex size-8 items-center justify-center rounded-lg text-white"
                                                        style={{background: brand.tile}}
                                                    >
                                                        {brand.Glyph
                                                            ? <brand.Glyph className="size-4"/>
                                                            : <Icon icon={Cpu} className="size-4 opacity-90"/>}
                                                    </span>
                                                }
                                                title={m.model}
                                                description={[
                                                    m.provider ?? "unknown",
                                                    callsLabel(m.call_count),
                                                    formatCost(m.cost_usd),
                                                ].filter(Boolean).join(" · ")}
                                                control={<TokenShare tokens={headlineTokens(m)} total={orgHeadline}/>}
                                            />
                                        );
                                    })}
                                </SettingsSection>
                            </>
                        )}
                    </>
                )}
            </SettingsPage>

            {isOwner && (
                <AgentUsageDrawer
                    open={selectedAgentId != null}
                    onOpenChange={(open) => { if (!open) setSelectedAgentId(null); }}
                    orgId={activeOrgId}
                    agentId={selectedAgentId}
                    agent={selectedAgentId ? agentsById.get(selectedAgentId) : undefined}
                    range={range}
                    rangeLabel={RANGES[range].label}
                    color={selectedAgentId ? (colorByAgent.get(selectedAgentId) ?? otherColor) : otherColor}
                    trend={selectedAgentId ? sparkFor(selectedAgentId) : []}
                    trendLabels={days.map((d) => dayLabel(d.date))}
                />
            )}
        </>
    );
}

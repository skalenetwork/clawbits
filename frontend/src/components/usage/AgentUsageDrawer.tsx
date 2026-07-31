import {useQuery} from "@tanstack/react-query";
import {CpuIcon as Cpu} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription} from "@/components/ui/sheet";
import {Skeleton} from "@/components/ui/skeleton";
import {AgentAvatarWithPresence} from "@/components/AgentStatus";
import {providerBrand} from "@/components/new-agent/brands";
import {getAgentUsage, type AgentUser, type UsageRange} from "@/lib/api";
import {agentDisplay} from "@/lib/agentDisplay";
import {queryKeys} from "@/lib/queryKeys";
import {exactFmt, formatCost, formatTokens, headlineTokens, shortModel} from "@/lib/usageFormat";

// ---------------------------------------------------------------------------
// Per-agent usage drill-down. Opens off an agent row in the ledger and reads
// the (already-built) per-agent endpoint for the model breakdown; the daily
// trend is reused from the org page's per-agent series so no extra round-trip
// is needed for it. Advisory telemetry — same honesty doctrine as the page.
// ---------------------------------------------------------------------------

const PROVIDER_ACCENT: Record<string, string> = {
    anthropic: "#D97757",
    openai: "#10A37F",
    google: "#4285F4",
    gemini: "#4285F4",
};

function MiniStat({label, value, sub}: {label: string; value: string; sub?: string | null}) {
    return (
        <div className="rounded-xl border border-border/50 bg-card px-3.5 py-3">
            <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
            <div className="mt-0.5 truncate text-xl font-semibold tabular-nums tracking-tight">{value}</div>
            {sub && <div className="truncate text-[11px] tabular-nums text-muted-foreground/70">{sub}</div>}
        </div>
    );
}

/** Single-series daily bars in the agent's ledger color. CSS-only (flex heights),
 *  so it scales to the sheet width without measuring. */
function MiniBars({values, labels, color}: {values: number[]; labels: string[]; color: string}) {
    const max = Math.max(1, ...values);
    const n = values.length;
    if (n === 0) return null;
    const first = labels[0] ?? "";
    const last = labels[n - 1] ?? "";
    return (
        <div>
            <div className="flex h-24 items-end gap-px">
                {values.map((v, i) => (
                    <div
                        key={labels[i] ?? i}
                        className="min-h-[2px] flex-1 rounded-t-[2px]"
                        style={{
                            height: `${String(Math.max(2, (v / max) * 100))}%`,
                            background: color,
                            opacity: v > 0 ? 1 : 0.18,
                        }}
                        title={`${labels[i] ?? ""}: ${formatTokens(v)} tokens`}
                    />
                ))}
            </div>
            {n > 1 && (
                <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground/60">
                    <span>{first}</span>
                    <span>{last}</span>
                </div>
            )}
        </div>
    );
}

export function AgentUsageDrawer({
    open, onOpenChange, orgId, agentId, agent, range, rangeLabel, color, trend, trendLabels,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    orgId: string;
    agentId: string | null;
    agent?: AgentUser;
    range: UsageRange;
    rangeLabel: string;
    color: string;
    /** Per-day headline tokens for this agent across the window (from the org page). */
    trend: number[];
    /** ISO day labels aligned to `trend`. */
    trendLabels: string[];
}) {
    const query = useQuery({
        queryKey: agentId
            ? queryKeys.agentUsage(orgId, agentId, range)
            : ["org", orgId, "agentUsage", "none", range],
        queryFn: () => getAgentUsage(orgId, agentId ?? "", {range}),
        enabled: open && Boolean(agentId) && Boolean(orgId),
    });

    const data = query.data;
    const name = agentDisplay(agent ?? (agentId ? {agent_id: agentId} : {}));
    const total = data?.total;
    const headline = total ? headlineTokens(total) : 0;
    const perModel = data?.per_model ?? [];
    const cacheHitRate = total && total.input_tokens + total.cache_read_tokens > 0
        ? total.cache_read_tokens / (total.input_tokens + total.cache_read_tokens)
        : null;
    const costPerCall = total?.cost_usd != null && total.call_count > 0
        ? total.cost_usd / total.call_count
        : null;

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full gap-0 p-0" style={{maxWidth: "30rem"}}>
                <SheetHeader className="border-b border-border/50 p-5">
                    <div className="flex items-center gap-3 pr-8">
                        {agentId && (
                            <AgentAvatarWithPresence
                                agentId={agentId}
                                name={name}
                                src={agent?.avatar?.url}
                                size={40}
                                ringClassName="ring-popover"
                            />
                        )}
                        <div className="min-w-0">
                            <SheetTitle className="truncate">{name}</SheetTitle>
                            <SheetDescription className="truncate">
                                {data && !data.reporting ? "Not reporting yet" : "Agent-reported usage"} · {rangeLabel}
                            </SheetDescription>
                        </div>
                    </div>
                </SheetHeader>

                <div className="flex-1 space-y-5 overflow-y-auto p-5">
                    {query.isLoading ? (
                        <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-3">
                                {Array.from({length: 4}).map((_, i) => <Skeleton key={i} className="h-[4.5rem] rounded-xl"/>)}
                            </div>
                            <Skeleton className="h-28 rounded-xl"/>
                            <Skeleton className="h-32 rounded-xl"/>
                        </div>
                    ) : query.isError ? (
                        <p className="py-8 text-center text-sm text-muted-foreground">Couldn&apos;t load this agent&apos;s usage.</p>
                    ) : total && (total.call_count > 0 || headline > 0) ? (
                        <>
                            <div className="grid grid-cols-2 gap-3">
                                <MiniStat
                                    label="Tokens"
                                    value={formatTokens(headline)}
                                    sub={`${formatTokens(total.input_tokens)} in · ${formatTokens(total.output_tokens)} out`}
                                />
                                <MiniStat
                                    label="Cache reads"
                                    value={formatTokens(total.cache_read_tokens)}
                                    sub={cacheHitRate != null ? `${(cacheHitRate * 100).toFixed(0)}% from cache` : null}
                                />
                                <MiniStat label="Model calls" value={exactFmt.format(total.call_count)}/>
                                <MiniStat
                                    label="Cost"
                                    value={formatCost(total.cost_usd) ?? "—"}
                                    sub={costPerCall != null ? `${formatCost(costPerCall) ?? ""}/call` : (total.cost_usd == null ? "no cost reported" : null)}
                                />
                            </div>

                            {trend.some((v) => v > 0) && (
                                <div>
                                    <h3 className="mb-2 text-xs font-medium text-muted-foreground">Daily tokens</h3>
                                    <MiniBars values={trend} labels={trendLabels} color={color}/>
                                </div>
                            )}

                            <div>
                                <h3 className="mb-2 text-xs font-medium text-muted-foreground">Models</h3>
                                {perModel.length === 0 ? (
                                    <p className="rounded-xl border border-border/50 px-3 py-6 text-center text-sm text-muted-foreground">
                                        No model calls in this period.
                                    </p>
                                ) : (
                                    <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/50">
                                        {perModel.map((m) => {
                                            const brand = providerBrand(m.provider === "google" ? "gemini" : (m.provider ?? ""));
                                            const accent = PROVIDER_ACCENT[m.provider ?? ""] ?? "#a8a29e";
                                            const share = headline > 0 ? headlineTokens(m) / headline : 0;
                                            return (
                                                <div key={`${m.model}:${m.provider ?? ""}`} className="flex items-center gap-3 px-3.5 py-2.5">
                                                    <span
                                                        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-white"
                                                        style={{background: brand.tile}}
                                                    >
                                                        {brand.Glyph ? <brand.Glyph className="size-3.5"/> : <Icon icon={Cpu} className="size-3.5 opacity-90"/>}
                                                    </span>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="truncate text-sm font-medium">{shortModel(m.model)}</div>
                                                        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                                                            <div className="h-full rounded-full" style={{width: `${String(share * 100)}%`, background: accent}}/>
                                                        </div>
                                                    </div>
                                                    <div className="shrink-0 text-right">
                                                        <div className="text-sm font-semibold tabular-nums">{formatTokens(headlineTokens(m))}</div>
                                                        <div className="text-[11px] tabular-nums text-muted-foreground/70">
                                                            {exactFmt.format(m.call_count)} {m.call_count === 1 ? "call" : "calls"}
                                                            {formatCost(m.cost_usd) ? ` · ${formatCost(m.cost_usd) ?? ""}` : ""}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <p className="py-8 text-center text-sm text-muted-foreground">
                            No usage reported for this agent in the selected period.
                        </p>
                    )}
                </div>
            </SheetContent>
        </Sheet>
    );
}

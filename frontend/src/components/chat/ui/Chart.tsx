import type { PieChart, SeriesChart, UiNodeOf } from "@/lib/a2ui/core";
import { cn } from "@/lib/utils";

/** The usage page's categorical slots, light then dark, cycled past the fifth. */
const PALETTE = [
  "text-[#2a78d6] dark:text-[#3987e5]",
  "text-[#008300]",
  "text-[#e87ba4] dark:text-[#d55181]",
  "text-[#eda100] dark:text-[#c98500]",
  "text-[#1baf7a] dark:text-[#199e70]",
];
const EXACT = new Intl.NumberFormat();
const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const MAX_LABELS = 6;

function colorAt(i: number): string | undefined {
  return PALETTE[i % PALETTE.length];
}

/** Each segment's share of the ring and where it starts, both in hundredths of the circle. */
function slices(segments: PieChart["segments"]) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  let start = 0;
  return segments.map((segment) => {
    const share = (segment.value / total) * 100;
    const slice = { ...segment, start, share };
    start += share;
    return slice;
  });
}

function Legend({ items }: { items: { label: string; detail?: string }[] }) {
  return (
    <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {items.map((item, i) => (
        <li key={i} className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full bg-current", colorAt(i))} />
          <span className="truncate">{item.label}</span>
          {item.detail && <span className="tabular-nums text-foreground/80">{item.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function Pie({ chart }: { chart: PieChart }) {
  const ring = slices(chart.segments);
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <svg viewBox="0 0 36 36" aria-hidden className="size-28 shrink-0 -rotate-90">
        {ring.map((slice, i) => (
          <circle
            key={i}
            cx={18}
            cy={18}
            r={14}
            fill="none"
            stroke="currentColor"
            strokeWidth={6}
            pathLength={100}
            strokeDasharray={`${slice.share} 100`}
            strokeDashoffset={-slice.start}
            className={colorAt(i)}
          >
            <title>{`${slice.label}: ${EXACT.format(slice.value)}`}</title>
          </circle>
        ))}
      </svg>
      <Legend items={ring.map((slice) => ({ label: slice.label, detail: `${Math.round(slice.share)}%` }))} />
    </div>
  );
}

/** Bars, lines and areas on one scale from zero; each category is one unit wide, so the marks stretch to any width
 *  while strokes and labels keep their size. */
function Plot({ chart }: { chart: SeriesChart }) {
  const { categories, series } = chart;
  const n = categories.length;
  const values = series.flatMap((s) => s.values);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const y = (v: number) => ((hi - v) / (hi - lo || 1)) * 100;
  const step = Math.ceil(n / MAX_LABELS);
  const barWidth = 0.7 / series.length;
  const line = (points: number[]) => points.map((v, i) => `${i === 0 ? "M" : "L"}${i + 0.5},${y(v)}`).join(" ");

  return (
    <div className="flex flex-col gap-1">
      {chart.yLabel && <span className="text-[11px] text-muted-foreground">{chart.yLabel}</span>}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
        <div className="flex h-40 flex-col justify-between text-right text-[10px] tabular-nums text-muted-foreground/70">
          <span>{COMPACT.format(hi)}</span>
          <span>{COMPACT.format(lo)}</span>
        </div>
        <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden className="h-40 w-full overflow-visible">
          <line x1={0} x2={n} y1={0} y2={0} vectorEffect="non-scaling-stroke" className="stroke-foreground/8" />
          <line x1={0} x2={n} y1={y(0)} y2={y(0)} vectorEffect="non-scaling-stroke" className="stroke-foreground/20" />
          {series.map((s, si) => (
            <g key={si} className={colorAt(si)}>
              {chart.chartType === "bar" ? (
                s.values.map((v, i) => (
                  <rect
                    key={i}
                    x={i + 0.15 + si * barWidth}
                    width={barWidth}
                    y={Math.min(y(v), y(0))}
                    height={Math.abs(y(v) - y(0))}
                    fill="currentColor"
                  />
                ))
              ) : (
                <>
                  {chart.chartType === "area" && (
                    <path d={`${line(s.values)} L${n - 0.5},${y(0)} L0.5,${y(0)} Z`} fill="currentColor" opacity={0.12} />
                  )}
                  <path
                    d={line(s.values)}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </>
              )}
            </g>
          ))}
          {categories.map((category, i) => (
            <rect key={i} x={i} width={1} height={100} fill="transparent">
              <title>{[category, ...series.map((s) => `${s.name}: ${EXACT.format(s.values[i] ?? 0)}`)].join(" · ")}</title>
            </rect>
          ))}
        </svg>
        <div
          className="col-start-2 grid text-[10px] text-muted-foreground/70"
          style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
        >
          {categories.map((category, i) =>
            i % step === 0 && (
              <span
                key={i}
                className={cn("truncate", step === 1 && "text-center")}
                style={{ gridColumn: `${i + 1} / span ${Math.min(step, n - i)}` }}
              >
                {category}
              </span>
            ),
          )}
        </div>
      </div>
      {chart.xLabel && <span className="text-center text-[11px] text-muted-foreground">{chart.xLabel}</span>}
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.name }))} />}
    </div>
  );
}

export function Chart({ node }: { node: UiNodeOf<"Chart"> }) {
  return (
    <figure className="flex w-full min-w-0 flex-col gap-2">
      <figcaption className="text-sm font-medium text-foreground">{node.title}</figcaption>
      {node.chartType === "pie" ? <Pie chart={node} /> : <Plot chart={node} />}
    </figure>
  );
}

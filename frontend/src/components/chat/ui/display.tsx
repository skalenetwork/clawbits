import { MessageMarkdown } from "@/components/MessageMarkdown";
import { StatusDot } from "@/components/settings/Settings";
import { resolveText, type Model, type Tone, type UiNodeOf } from "@/lib/a2ui/core";
import { TONE_FILL } from "@/lib/status";
import { cn } from "@/lib/utils";

const TONE_BAR = { ...TONE_FILL, idle: "bg-foreground/15" } satisfies Record<Tone, string>;
const TREND = { up: "↑", down: "↓", flat: "→" } as const;

export function Text({ node, model }: { node: UiNodeOf<"Text">; model: Model }) {
  return (
    <MessageMarkdown
      content={resolveText(node.text, model)}
      variant="surface"
      className={node.variant === "caption" ? "text-[13px]/[18px] text-muted-foreground" : undefined}
    />
  );
}

export function Notice({ node }: { node: UiNodeOf<"Notice"> }) {
  return (
    <div className="flex gap-2.5 rounded-lg bg-muted/35 py-2 pr-3 pl-2.5 text-[13px]/[18px]">
      <span aria-hidden className={cn("w-0.5 shrink-0 rounded-full", TONE_BAR[node.tone])} />
      <div className="min-w-0 text-pretty break-words">
        {node.title && <p className="text-sm font-medium text-foreground">{node.title}</p>}
        <p className={node.title ? "text-muted-foreground" : "text-foreground"}>{node.text}</p>
      </div>
    </div>
  );
}

export function KeyValue({ node }: { node: UiNodeOf<"KeyValue"> }) {
  return (
    <dl className="grid grid-cols-[fit-content(45%)_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]/5">
      {node.items.flatMap(({ label, value }, i) => [
        <dt key={`${i}-label`} className="break-words text-muted-foreground">{label}</dt>,
        <dd key={`${i}-value`} className="break-words text-foreground">{value}</dd>,
      ])}
    </dl>
  );
}

export function Stats({ node }: { node: UiNodeOf<"Stats"> }) {
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-x-4 gap-y-3">
      {node.items.map((item, i) => (
        <div key={i} className="flex min-w-0 flex-col gap-0.5">
          <dt className="truncate text-xs font-medium text-muted-foreground">{item.label}</dt>
          <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className="break-words text-xl font-semibold tabular-nums tracking-tight text-foreground">
              {item.value}
            </span>
            {item.unit && <span className="text-[13px] text-muted-foreground">{item.unit}</span>}
            {(item.delta || item.trend) && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-foreground/6 px-1.5 py-px text-[11px] font-medium tabular-nums text-muted-foreground">
                {item.trend && TREND[item.trend]}
                {item.delta}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function StatusList({ node }: { node: UiNodeOf<"StatusList"> }) {
  return (
    <ul className="divide-y divide-foreground/8">
      {node.items.map((item, i) => (
        <li key={i} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 py-1.5 first:pt-0 last:pb-0">
          <StatusDot tone={item.tone} className="size-[7px]" />
          <span className="break-words text-sm text-foreground">{item.title}</span>
          {item.subtitle && (
            <span className="col-start-2 break-words text-[13px]/[18px] text-muted-foreground">{item.subtitle}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Wider than the chat column, the table scrolls inside its frame. */
export function Table({ node }: { node: UiNodeOf<"Table"> }) {
  return (
    <figure className="flex w-full min-w-0 flex-col gap-1.5">
      {node.caption && <figcaption className="text-sm font-medium text-foreground">{node.caption}</figcaption>}
      <div className="overflow-x-auto rounded-lg ring-1 ring-inset ring-border/60">
        <table className="w-full border-collapse text-[13px] tabular-nums">
          <thead className="bg-muted/50">
            <tr>
              {node.headers.map((header, i) => (
                <th key={i} scope="col" className="px-2.5 py-1.5 text-left font-semibold whitespace-nowrap text-muted-foreground">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {node.rows.map((row, r) => (
              <tr key={r} className="border-t border-border/40">
                {row.map((value, c) =>
                  c === node.rowHeaderColumnIndex ? (
                    <th key={c} scope="row" className="px-2.5 py-1.5 text-left align-top font-medium">{value}</th>
                  ) : (
                    <td key={c} className="px-2.5 py-1.5 align-top">{value}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

import { ChevronRight } from "lucide-react";

export function RawHeaders({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return null;
  return (
    <details className="group">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground transition-colors select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
        Technical details
      </summary>
      <dl className="mt-2 flex max-h-72 flex-col gap-1.5 overflow-y-auto rounded-[10px] bg-foreground/5 p-3 font-mono text-label">
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

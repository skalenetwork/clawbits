/**
 * RawHeaders — the message's full header dict as a mono key/value grid,
 * behind a quiet disclosure. Provenance for power users (Received chain,
 * DKIM results, content type) that the API already returns but the old UI
 * never showed.
 */
export function RawHeaders({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return null;
  return (
    <div className="max-h-72 overflow-y-auto rounded-xl border border-border/60 bg-muted/30 p-3">
      <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1">
        {entries.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="truncate font-mono text-label text-muted-foreground">{key}</dt>
            <dd className="break-all font-mono text-label text-foreground/80">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

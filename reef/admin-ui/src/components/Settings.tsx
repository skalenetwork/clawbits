import { useEffect, useState } from "react"
import { Globe02Icon, Link01Icon, Settings02Icon } from "@hugeicons/core-free-icons"
import { useSettings, useUpdateSettings } from "@/lib/queries"
import { Icon } from "@/components/Icon"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** Operator settings. Today: the public URL override — the origin agent Control
 *  UI / terminal links are built on. Set here it wins over REEF_PUBLIC_URL with
 *  no restart, so an operator can repoint the surface links at a new tunnel. */
export function Settings() {
  const settings = useSettings()
  const update = useUpdateSettings()
  const override = settings.data?.public_url_override ?? null
  const env = settings.data?.public_url_env ?? null
  const effective = settings.data?.public_url_effective ?? null

  const [draft, setDraft] = useState("")
  // Seed the field with the current override once it lands (and when it changes
  // — e.g. after a save/clear); typing in between is preserved unless it moves.
  useEffect(() => {
    setDraft(override ?? "")
  }, [override])

  const trimmed = draft.trim()
  const dirty = trimmed !== (override ?? "")
  const badUrl = trimmed.length > 0 && !/^https?:\/\//i.test(trimmed)
  const source = override ? "Override" : env ? "REEF_PUBLIC_URL" : "Request origin"

  return (
    <div className="space-y-6">
      <PageHeader icon={Settings02Icon} title="Settings" />

      <section className="mx-auto max-w-2xl">
        <div className="space-y-4 rounded-2xl border border-border/50 bg-foreground/[0.02] p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted [&_svg]:size-[18px]">
              <Icon icon={Globe02Icon} />
            </span>
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-semibold">Public URL</h2>
              <p className="text-[13px] leading-snug text-muted-foreground">
                The origin agent Control UI &amp; terminal links are built on (your tunnel URL).
                Setting it here wins over the <code className="font-mono text-xs">REEF_PUBLIC_URL</code>{" "}
                env var — no restart needed.
              </p>
            </div>
          </div>

          {/* What's in effect right now, and where it comes from. */}
          <div className="rounded-lg bg-muted/40 px-3 py-2.5">
            <div className="mb-1 text-xs text-muted-foreground">Currently using · {source}</div>
            <code className="font-mono text-[13px] break-all text-foreground">
              {effective ?? "— falls back to the request origin"}
            </code>
          </div>

          {/* The override field. */}
          <div className="space-y-2">
            <label htmlFor="public-url" className="text-xs font-medium text-muted-foreground">
              Override
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">
                <Icon icon={Link01Icon} className="size-4" />
              </span>
              <Input
                id="public-url"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                }}
                placeholder={env ?? "https://your-reef.example.com"}
                className="pl-9 font-mono text-sm"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={badUrl}
                disabled={update.isPending || settings.isLoading}
              />
            </div>
            {badUrl ? (
              <p className="text-xs text-destructive">Must be an http(s) URL.</p>
            ) : env ? (
              <p className="text-xs text-muted-foreground">
                Leave blank to use <code className="font-mono">REEF_PUBLIC_URL</code>.
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!dirty || badUrl || update.isPending || settings.isLoading}
              onClick={() => {
                update.mutate(trimmed || null)
              }}
            >
              {update.isPending ? "Saving…" : "Save"}
            </Button>
            {override && (
              <Button
                size="sm"
                variant="outline"
                disabled={update.isPending}
                onClick={() => {
                  update.mutate(null)
                }}
              >
                Clear override
              </Button>
            )}
          </div>

          {settings.isError && (
            <p className="text-xs text-destructive">Couldn't load settings — check the API and reload.</p>
          )}
        </div>
      </section>
    </div>
  )
}

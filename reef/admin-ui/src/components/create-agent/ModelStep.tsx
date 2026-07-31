/**
 * Step 3 - Provider. ONE decision, in the same card language as the Type step:
 * icon on a brand tile, name, one-line descriptor. Picking a card advances;
 * keys / hosts / model choices are the Options step's business. A reef-configured
 * provider carries a "Ready" pill; a card the picked runtime can't consume is
 * disabled with a tooltip.
 */
import { SparklesIcon, Tick01Icon } from "@hugeicons/core-free-icons"
import { Icon } from "@/components/Icon"
import type { ProviderInfo } from "@/lib/api"
import { providerBrand } from "./brands"
import { OptionCard } from "./bits"

function supportsRuntime(p: ProviderInfo, runtime: string | null): boolean {
  if (!p.runtimes || runtime === null) return true
  return p.runtimes.includes(runtime)
}

export function ModelStep({
  runtime,
  providerId,
  providers,
  providersLoading,
  providersError,
  onPick,
}: {
  runtime: string | null
  providerId: string | null
  providers: ProviderInfo[] | null
  providersLoading: boolean
  providersError: boolean
  onPick: (id: string) => void
}) {
  if (providersError && !providers) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-4 text-center">
        <Icon icon={SparklesIcon} className="size-6 text-destructive" />
        <p className="text-sm text-destructive">
          Couldn't load this Reef's providers - check the API and reopen.
        </p>
      </div>
    )
  }
  if (providersLoading || !providers) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-muted-foreground">
        <span className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
        <p className="text-sm">Loading providers…</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {providers.map((p) => {
        const brand = providerBrand(p.id)
        const unsupported = !supportsRuntime(p, runtime)
        return (
          <OptionCard
            key={p.id}
            icon={
              brand.Glyph ? (
                <brand.Glyph className={p.kind === "oauth" ? "size-9!" : undefined} />
              ) : (
                <Icon icon={SparklesIcon} />
              )
            }
            tile={brand.tile}
            title={p.label}
            line={
              unsupported ? `Not available for ${runtime ?? "this runtime"} images yet` : brand.line
            }
            trailing={
              p.kind === "oauth" ? (
                // Not a reef-configured key - the operator signs in with their
                // own ChatGPT plan after launch.
                <span className="flex items-center gap-1.5 rounded-full bg-foreground/[0.06] px-3 py-1 text-[13px] font-semibold text-muted-foreground">
                  No key needed
                </span>
              ) : p.configured ? (
                <span className="flex items-center gap-1.5 rounded-full bg-success/15 px-3 py-1 text-[13px] font-semibold text-success">
                  <Icon icon={Tick01Icon} className="size-4" />
                  Ready
                </span>
              ) : undefined
            }
            selected={providerId === p.id}
            disabled={unsupported}
            onSelect={() => {
              onPick(p.id)
            }}
          />
        )
      })}
      <OptionCard
        icon={<Icon icon={SparklesIcon} className="text-muted-foreground" />}
        title="Skip for now"
        line="Pick a model later in the Control UI"
        selected={providerId === "none"}
        onSelect={() => {
          onPick("none")
        }}
      />
    </div>
  )
}

/**
 * Step 3 — Provider (reef path only). ONE decision, in the same card language
 * as the Runs-on / Type steps: icon on a brand tile, name, one-line
 * descriptor. Picking a card advances; keys / hosts / model choices are the
 * Options step's business. A reef-configured provider carries a "Ready" pill;
 * a card the picked runtime can't consume is disabled with a tooltip.
 */
import {Tick01Icon as Check, Comment02Icon as SkipGlyph} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import type {ReefProvider} from "@/lib/reefApi";
import {providerBrand} from "./brands";
import {OptionCard} from "./bits";
import type {Runtime, WizardState} from "./useWizard";

function supportsRuntime(p: ReefProvider, runtime: Runtime | null): boolean {
    if (!p.runtimes || runtime === null) return true;
    return p.runtimes.includes(runtime);
}

export function ModelStep({
    state,
    providers,
    providersLoading,
    onPick,
}: {
    state: WizardState;
    providers: ReefProvider[] | null;
    providersLoading: boolean;
    onPick: (id: string) => void;
}) {
    if (providersLoading || !providers) {
        return (
            <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-muted-foreground">
                <span className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"/>
                <p className="text-sm">Loading providers…</p>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {providers.map((p) => {
                const brand = providerBrand(p.id);
                const unsupported = !supportsRuntime(p, state.runtime);
                return (
                    <OptionCard
                        key={p.id}
                        icon={
                            brand.Glyph
                                ? <brand.Glyph className={p.kind === "oauth" ? "size-9!" : undefined}/>
                                : <Icon icon={SkipGlyph}/>
                        }
                        tile={brand.tile}
                        title={p.label}
                        line={
                            unsupported
                                ? `Not available for ${state.runtime ?? "this runtime"} images yet`
                                : brand.line
                        }
                        trailing={
                            p.kind === "oauth" ? (
                                // Not a reef-configured key — the owner signs in
                                // with their own ChatGPT plan after launch.
                                <span className="flex items-center gap-1.5 rounded-full bg-foreground/[0.06] px-3 py-1 text-[13px] font-semibold text-muted-foreground">
                                    No key needed
                                </span>
                            ) : p.configured ? (
                                <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-[13px] font-semibold text-emerald-600 dark:text-emerald-400">
                                    <Icon icon={Check} className="size-4"/>
                                    Ready
                                </span>
                            ) : undefined
                        }
                        selected={state.providerId === p.id}
                        disabled={unsupported}
                        onSelect={() => { onPick(p.id); }}
                    />
                );
            })}
            <OptionCard
                icon={<Icon icon={SkipGlyph} className="text-muted-foreground"/>}
                title="Skip for now"
                line="Pick a model later in the Control UI"
                selected={state.providerId === "none"}
                onSelect={() => { onPick("none"); }}
            />
        </div>
    );
}

import {PlusSignIcon as Plus, RepeatIcon as Repeat} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {ACCENT_BG, AUTOMATION_TEMPLATES, type AutomationTemplate} from "@/lib/automations";
import {describeSchedule} from "@/lib/schedule";
import type {Automation} from "@/lib/api";
import {cn} from "@/lib/utils";

/**
 * The recipe shelf — suggestions wearing the SAME card anatomy as the
 * assigned automations (parchment card, accent icon well left, name + cadence
 * right), so a recipe reads as "an automation you don't have yet", not a
 * different species. A recipe never one-click-creates: tapping opens the
 * Forge prefilled, because confirming the schedule is the trust ritual.
 * Personalization is honest about what we know client-side: templates
 * already running are hidden.
 */
export function RecipeShelf({automations, onPick}: {
    /** Existing automations — used to hide already-created template names. */
    automations: Automation[];
    onPick: (template: AutomationTemplate) => void;
}) {
    const existingNames = new Set(automations.map(a => (a.name ?? "").toLowerCase()));
    // The catalog is bigger than the shelf: hide what's already running, show
    // the top 3 — as automations get created, fresh suggestions surface.
    const recipes = AUTOMATION_TEMPLATES.filter(
        t => !existingNames.has(t.defaultName.toLowerCase()),
    ).slice(0, 3);
    if (recipes.length === 0) return null;

    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {recipes.map(t => (
                <button
                    key={t.id}
                    type="button"
                    onClick={() => { onPick(t); }}
                    className={cn(
                        "group flex flex-col rounded-xl border border-border/60 bg-card p-4 text-left",
                        "cursor-pointer transition duration-150 ease-out hover:border-border hover:bg-muted/40",
                        "active:scale-[0.99] motion-reduce:transition-none",
                    )}
                >
                    <span className="flex items-start gap-3">
                        <span
                            className={cn(
                                "flex size-12 shrink-0 items-center justify-center rounded-xl text-white",
                                t.accent ? ACCENT_BG[t.accent] : "bg-muted",
                            )}
                        >
                            {t.icon && <Icon icon={t.icon} className="size-6"/>}
                        </span>
                        <span className="min-w-0 flex-1 self-center">
                            <span className="block truncate text-base font-semibold leading-snug tracking-tight text-foreground">
                                {t.label}
                            </span>
                            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
                                <Icon icon={Repeat} className="size-3.5 shrink-0 opacity-70"/>
                                <span className="truncate">{describeSchedule(t.defaultSchedule)}</span>
                            </span>
                        </span>
                        <span
                            aria-hidden
                            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground/0 transition-colors group-hover:text-muted-foreground"
                        >
                            <Icon icon={Plus} className="size-4"/>
                        </span>
                    </span>
                    <span className="mt-3 line-clamp-2 block text-caption leading-snug text-muted-foreground">
                        {t.description}
                    </span>
                </button>
            ))}
        </div>
    );
}

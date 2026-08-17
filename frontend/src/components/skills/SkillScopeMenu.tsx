import {Fragment} from "react";
import {ArrowDown01Icon as ArrowDown} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    SKILL_SCOPES,
    skillScopeLabel,
    type SkillScope,
} from "@/lib/skillScopes";
import {cn} from "@/lib/utils";

/**
 * The scope filter, worn as the sidebar's title.
 *
 * The header already renders a title, so the title IS the control: one row of
 * chrome disappears instead of being styled. At a 15rem sidebar that matters —
 * a stacked search field and select box cost roughly two visible skills. It
 * reads as a heading until hovered, and carries the matching count so the
 * filter never hides its own effect.
 *
 * Hosted by the desktop sidebar header and the mobile page header alike, which
 * is why it takes its own counts instead of reaching for a list.
 */
export function SkillScopeMenu({
    scope,
    onScopeChange,
    counts,
    className,
}: {
    scope: SkillScope;
    onScopeChange: (scope: SkillScope) => void;
    /** Per-scope match counts, so a row can show what picking it would give. */
    counts: Record<SkillScope, number>;
    className?: string;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                className={cn(
                    "-ml-1.5 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-semibold text-sidebar-foreground",
                    "outline-none transition-colors hover:bg-[var(--sb-hover)] focus-visible:ring-2 focus-visible:ring-ring/50",
                    className,
                )}
            >
                <span className="truncate">{skillScopeLabel(scope)}</span>
                <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                    {counts[scope]}
                </span>
                <Icon icon={ArrowDown} className="size-3 shrink-0 text-muted-foreground"/>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-52">
                <DropdownMenuRadioGroup
                    value={scope}
                    onValueChange={(v) => { onScopeChange(v as SkillScope); }}
                >
                    {SKILL_SCOPES.filter(s => !s.disabled).map(s => (
                        <DropdownMenuRadioItem key={s.id} value={s.id}>
                            <Icon icon={s.icon} className="text-muted-foreground"/>
                            <span>{s.label}</span>
                            <span className="ml-auto pr-4 text-xs text-muted-foreground tabular-nums">
                                {counts[s.id]}
                            </span>
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
                {/* Shown but not pickable. Hiding it would make the product
                    look finished; a scope that silently returned nothing would
                    be worse still. */}
                {SKILL_SCOPES.filter(s => s.disabled).map(s => (
                    <Fragment key={s.id}>
                        <DropdownMenuSeparator/>
                        <DropdownMenuItem disabled>
                            <Icon icon={s.icon} className="text-muted-foreground"/>
                            <span>{s.label}</span>
                        </DropdownMenuItem>
                    </Fragment>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

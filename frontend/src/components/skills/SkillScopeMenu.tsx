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
import {SKILL_SCOPES, skillScopeLabel, type SkillScope} from "@/lib/skillScopes";

export function SkillScopeMenu({scope, onScopeChange, counts}: {
    scope: SkillScope;
    onScopeChange: (scope: SkillScope) => void;
    counts: Record<SkillScope, number>;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className="-ml-1.5 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-semibold text-sidebar-foreground outline-none transition-colors hover:bg-[var(--sb-hover)] focus-visible:ring-2 focus-visible:ring-ring/50">
                <span className="truncate">{skillScopeLabel(scope)}</span>
                <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                    {counts[scope]}
                </span>
                <Icon icon={ArrowDown} className="size-3 shrink-0 text-muted-foreground"/>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-52">
                <DropdownMenuRadioGroup value={scope} onValueChange={onScopeChange}>
                    {SKILL_SCOPES.filter(s => !s.disabled).map(s => (
                        <DropdownMenuRadioItem key={s.id} value={s.id}>
                            <Icon icon={s.icon}/>
                            <span>{s.label}</span>
                            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                {counts[s.id]}
                            </span>
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
                {/* Disabled scopes stay visible on purpose: hiding them would make the product look finished. */}
                {SKILL_SCOPES.filter(s => s.disabled).map(s => (
                    <Fragment key={s.id}>
                        <DropdownMenuSeparator/>
                        <DropdownMenuItem disabled>
                            <Icon icon={s.icon}/>
                            <span>{s.label}</span>
                        </DropdownMenuItem>
                    </Fragment>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

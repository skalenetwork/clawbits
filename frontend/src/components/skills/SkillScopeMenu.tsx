import {ArrowDown01Icon as ArrowDown, Globe02Icon} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {SELECT_SM} from "@/components/ui/select";
import type {Skill} from "@/lib/api";
import {SKILL_SCOPES, filterSkillsByScope, type SkillScope} from "@/lib/skillScopes";
import {cn} from "@/lib/utils";

/** The library's scope as a select, each scope with its count. Public is listed but can't be picked yet. */
export function SkillScopeMenu({skills, userId, scope, onScopeChange, className}: {
    skills: Skill[];
    userId: number | null;
    scope: SkillScope;
    onScopeChange: (scope: SkillScope) => void;
    className?: string;
}) {
    const count = (id: SkillScope) => filterSkillsByScope(skills, id, userId).length;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={cn(SELECT_SM, "shrink-0 justify-self-start", className)}>
                {SKILL_SCOPES.find(s => s.id === scope)?.label}
                <span className="text-xs font-normal text-muted-foreground tabular-nums">{count(scope)}</span>
                <Icon icon={ArrowDown} className="size-4 text-muted-foreground"/>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-52">
                <DropdownMenuRadioGroup value={scope} onValueChange={onScopeChange}>
                    {SKILL_SCOPES.map(s => (
                        <DropdownMenuRadioItem key={s.id} value={s.id}>
                            <Icon icon={s.icon}/>
                            {s.label}
                            <DropdownMenuShortcut className="tabular-nums">{count(s.id)}</DropdownMenuShortcut>
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator/>
                <DropdownMenuItem disabled>
                    <Icon icon={Globe02Icon}/>
                    Public
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

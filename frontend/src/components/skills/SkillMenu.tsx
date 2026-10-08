import {useNavigate} from "react-router-dom";
import {useMutation, useQueryClient} from "@tanstack/react-query";
import {
    Delete02Icon as Trash,
    GitForkIcon as Fork,
    MoreHorizontalIcon as More,
    PencilEdit02Icon as Pencil,
    PlusSignIcon as Plus,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {Button} from "@/components/ui/button";
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger} from "@/components/ui/dropdown-menu";
import {useAuth} from "@/context/AuthContext";
import {deleteSkill, forkSkill, type Skill} from "@/lib/api";
import {confirm} from "@/lib/confirm";
import {queryKeys} from "@/lib/queryKeys";
import {skillDetailPath} from "@/lib/skills";
import {toast} from "@/lib/toast";

/** A skill's ··· menu on its library tile and its page; Add and Edit show only where the caller has no button for
 *  them. A fork opens the copy and a delete lands on the library. Errors toast from the global mutation handler. */
export function SkillMenu({skill, onAdd, onEdit}: {skill: Skill; onAdd?: () => void; onEdit?: () => void}) {
    const {activeOrgId} = useAuth();
    const orgId = activeOrgId ?? "";
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    const fork = useMutation({
        mutationFn: () => forkSkill(orgId, skill.skill_id),
        onSuccess: (created) => {
            void queryClient.invalidateQueries({queryKey: queryKeys.skills(orgId)});
            toast.success(`Forked as ${created.slug}`);
            void navigate(skillDetailPath(created));
        },
    });
    const remove = useMutation({
        mutationFn: () => deleteSkill(orgId, skill.skill_id),
        onSuccess: () => {
            void queryClient.invalidateQueries({queryKey: queryKeys.skills(orgId)});
            toast.success("Skill deleted");
            void navigate("/skills", {replace: true});
        },
    });

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                aria-label={`Actions for ${skill.display_name}`}
                render={<Button variant="ghost" size="icon-xs" className="size-7"/>}
            >
                <Icon icon={More}/>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {onAdd && !skill.is_draft && <DropdownMenuItem onClick={onAdd}><Icon icon={Plus}/>Add to agents</DropdownMenuItem>}
                {onEdit && <DropdownMenuItem onClick={onEdit}><Icon icon={Pencil}/>Edit</DropdownMenuItem>}
                {!skill.is_draft && (
                    <DropdownMenuItem disabled={fork.isPending} onClick={() => { fork.mutate(); }}><Icon icon={Fork}/>Fork</DropdownMenuItem>
                )}
                <DropdownMenuItem
                    variant="destructive"
                    disabled={remove.isPending}
                    onClick={() => {
                        void confirm({
                            title: `Delete ${skill.display_name}?`,
                            description: `It's removed from the library and from every agent that has it. Its version history is kept, and the identifier ${skill.slug} becomes available again.`,
                            confirmLabel: "Delete",
                        }).then((ok) => {
                            if (ok) remove.mutate();
                        });
                    }}
                >
                    <Icon icon={Trash}/>
                    Delete
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

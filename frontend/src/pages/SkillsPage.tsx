import {useState} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {
    BookOpen01Icon as Book,
    PlusSignIcon as Plus,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {PageHeader} from "@/components/PageHeader";
import {SkillCard} from "@/components/skills/SkillCard";
import {SkillForge} from "@/components/skills/SkillForge";
import {Button} from "@/components/ui/button";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import {useAuth} from "@/context/AuthContext";
import {deleteSkill, forkSkill, listOrgSkills, type Skill} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";

/** The org's skill library. */
export default function SkillsPage() {
    const {activeOrgId} = useAuth();
    const queryClient = useQueryClient();
    const [forgeOpen, setForgeOpen] = useState(false);
    const [editing, setEditing] = useState<Skill | null>(null);
    const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);

    const skillsQuery = useQuery({
        queryKey: queryKeys.skills(activeOrgId ?? ""),
        queryFn: () => listOrgSkills(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId),
    });

    const invalidate = () => {
        void queryClient.invalidateQueries({queryKey: queryKeys.skills(activeOrgId ?? "")});
    };

    const fork = useMutation({
        mutationFn: (s: Skill) => forkSkill(activeOrgId ?? "", s.skill_id),
        onSuccess: (created) => {
            invalidate();
            toast.success(`Forked as ${created.slug}`);
        },
        onError: (e) => { toast.error(errMsg(e)); },
    });

    const remove = useMutation({
        mutationFn: (s: Skill) => deleteSkill(activeOrgId ?? "", s.skill_id),
        onSuccess: () => {
            invalidate();
            setPendingDelete(null);
            toast.success("Skill deleted");
        },
        onError: (e) => { toast.error(errMsg(e)); },
    });

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    const skills = skillsQuery.data?.skills ?? [];

    return (
        <div className="space-y-6 pb-16">
            <PageHeader
                icon={Book}
                title="Skills"
                actions={
                    <Button
                        size="sm"
                        onClick={() => { setEditing(null); setForgeOpen(true); }}
                    >
                        <Icon icon={Plus} className="size-4"/>
                        New skill
                    </Button>
                }
            />

            {skillsQuery.isPending ? (
                <div className="text-sm text-muted-foreground">Loading skills…</div>
            ) : skillsQuery.isError ? (
                <div className="text-sm text-destructive">{errMsg(skillsQuery.error)}</div>
            ) : skills.length === 0 ? (
                <EmptyState onCreate={() => { setEditing(null); setForgeOpen(true); }}/>
            ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {skills.map(skill => (
                        <SkillCard
                            key={skill.skill_id}
                            skill={skill}
                            actions={{
                                onEdit: (s) => { setEditing(s); setForgeOpen(true); },
                                onFork: (s) => { fork.mutate(s); },
                                onDelete: (s) => { setPendingDelete(s); },
                            }}
                        />
                    ))}
                </div>
            )}

            <SkillForge
                open={forgeOpen}
                editing={editing}
                onOpenChange={(open) => {
                    setForgeOpen(open);
                    if (!open) setEditing(null);
                }}
            />

            <Dialog
                open={pendingDelete != null}
                onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogTitle>Delete {pendingDelete?.display_name}?</DialogTitle>
                    <DialogDescription>
                        It's removed from the library. Its version history is kept, and
                        the name <span className="font-mono">{pendingDelete?.slug}</span> becomes
                        available again.
                    </DialogDescription>
                    <DialogFooter>
                        <DialogClose render={<Button variant="ghost" />}>
                            Cancel
                        </DialogClose>
                        <Button
                            variant="destructive"
                            disabled={remove.isPending}
                            onClick={() => { if (pendingDelete) remove.mutate(pendingDelete); }}
                        >
                            {remove.isPending ? "Deleting…" : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function EmptyState({onCreate}: {onCreate: () => void}) {
    return (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 px-6 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Icon icon={Book} className="size-6"/>
            </span>
            <h2 className="mt-4 text-base font-semibold tracking-tight text-foreground">
                No skills yet
            </h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                A skill is a set of instructions your agents can follow — how your team
                writes changelogs, how to triage an invoice, the house style for a
                report.
            </p>
            <Button className="mt-4" size="sm" onClick={onCreate}>
                <Icon icon={Plus} className="size-4"/>
                New skill
            </Button>
        </div>
    );
}

import {useState} from "react";
import {useMutation, useQueryClient} from "@tanstack/react-query";
import {PencilEdit02Icon as Pencil} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {useAuth} from "@/context/AuthContext";
import {renameAgent} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

export interface RenameTarget {
    agent_id: string;
    nickname?: string | null;
}

/**
 * Operator-only rename dialog. Writes ``Agent.nickname`` server-side
 * (PATCH …/agents/{id}/name); the backend clears any agent-set profile
 * display_name so the new name is what every surface shows. The agent_id
 * (and thus URLs, avatars, DM keys) never changes.
 *
 * Pass ``agent`` to open, null to close — the inner form remounts per
 * agent (keyed), so the input prefills without effects.
 */
export function RenameAgentDialog({agent, onOpenChange}: {
    agent: RenameTarget | null;
    onOpenChange: (open: boolean) => void;
}) {
    const open = agent !== null;
    // Cache the target so the form stays mounted through the exit transition
    // (unmounting mid-close cancels the popup's CSS transition and base-ui
    // then never finishes closing). The epoch keys a fresh form per open so
    // an abandoned draft doesn't survive a reopen. Render-time setState is
    // the documented "information from previous renders" pattern.
    const [target, setTarget] = useState<RenameTarget | null>(null);
    const [epoch, setEpoch] = useState(0);
    const [wasOpen, setWasOpen] = useState(false);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) {
            setTarget(agent);
            setEpoch(e => e + 1);
        }
    }
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                {target && (
                    <RenameForm
                        key={`${target.agent_id}:${String(epoch)}`}
                        agent={target}
                        onOpenChange={onOpenChange}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function RenameForm({agent, onOpenChange}: {
    agent: RenameTarget;
    onOpenChange: (open: boolean) => void;
}) {
    const {activeOrgId} = useAuth();
    const queryClient = useQueryClient();
    const current = agent.nickname ?? agent.agent_id;
    const [name, setName] = useState(current);

    const mutation = useMutation({
        mutationFn: (nickname: string) =>
            renameAgent(activeOrgId ?? "", agent.agent_id, nickname),
        onSuccess: (data) => {
            if (activeOrgId) {
                void queryClient.invalidateQueries({queryKey: queryKeys.agents(activeOrgId)});
                void queryClient.invalidateQueries({queryKey: queryKeys.agentProfile(activeOrgId, data.agent_id)});
                // DM titles derive from the agent's resolved name.
                void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            }
            toast.success(`Renamed to ${data.nickname}`);
            onOpenChange(false);
        },
        onError: (err: unknown) => { toast.error(errMsg(err, "Couldn't rename agent")); },
    });

    const trimmed = name.trim();
    const canSave = trimmed.length > 0 && trimmed !== current && !mutation.isPending;

    return (
        <>
            <DialogHeader>
                <DialogTitle>
                    <Icon icon={Pencil} className="text-muted-foreground"/>
                    Rename agent
                </DialogTitle>
                <DialogDescription>
                    Shown everywhere instead of the generated name. The handle{" "}
                    <strong>@{agent.agent_id}</strong> stays the same.
                </DialogDescription>
            </DialogHeader>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    if (canSave) mutation.mutate(trimmed);
                }}
            >
                <Input
                    autoFocus
                    value={name}
                    maxLength={32}
                    onChange={(e) => { setName(e.target.value); }}
                    placeholder="Agent name"
                    aria-label="Agent name"
                />
                <DialogFooter className="mt-4">
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => { onOpenChange(false); }}
                        disabled={mutation.isPending}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" disabled={!canSave}>
                        {mutation.isPending ? "Renaming…" : "Rename"}
                    </Button>
                </DialogFooter>
            </form>
        </>
    );
}

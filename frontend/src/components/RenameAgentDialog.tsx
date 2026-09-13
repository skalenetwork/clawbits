import {useState} from "react";
import {useMutation, useQueryClient} from "@tanstack/react-query";
import {
    ModalButton,
    ModalField,
    ModalFooter,
    ModalHeader,
    ModalPanel,
} from "@/components/modals/Modal";
import {useAuth} from "@/context/AuthContext";
import {renameAgent} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";
import {Input} from "@/components/ui/input";
import {DialogDescription} from "@/components/ui/dialog";

interface RenameTarget {
    agent_id: string;
    nickname?: string | null;
}

/** Pass `agent` to open, null to close. */
export function RenameAgentDialog({agent, onOpenChange}: {
    agent: RenameTarget | null;
    onOpenChange: (open: boolean) => void;
}) {
    const open = agent !== null;
    // The target outlives the close so the form stays mounted through the exit transition; each open keys a fresh form.
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
        <ModalPanel open={open} onOpenChange={onOpenChange} kind="form">
            {target && <RenameForm key={epoch} agent={target} onOpenChange={onOpenChange}/>}
        </ModalPanel>
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
        mutationFn: (nickname: string) => renameAgent(activeOrgId ?? "", agent.agent_id, nickname),
        onSuccess: data => {
            if (activeOrgId) {
                void queryClient.invalidateQueries({queryKey: queryKeys.agents(activeOrgId)});
                void queryClient.invalidateQueries({queryKey: queryKeys.agentProfile(activeOrgId, data.agent_id)});
                void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            }
            toast.success(`Renamed to ${data.nickname}`);
            onOpenChange(false);
        },
        onError: err => { toast.error(errMsg(err, "Couldn't rename agent")); },
    });

    const trimmed = name.trim();
    const canSave = trimmed.length > 0 && trimmed !== current && !mutation.isPending;

    return (
        <>
            <ModalHeader title="Rename agent"/>
            <form
                onSubmit={e => {
                    e.preventDefault();
                    if (canSave) mutation.mutate(trimmed);
                }}
            >
                <div className="p-4">
                    <ModalField label="Name" htmlFor="rename-agent-name">
                        <Input
                            id="rename-agent-name"
                            autoFocus
                            value={name}
                            maxLength={32}
                            onChange={e => { setName(e.target.value); }}
                            placeholder="Agent name"
                        />
                        <DialogDescription className="text-[12px] text-muted-foreground">
                            Shown everywhere instead of the generated name. The handle @{agent.agent_id}
                            stays the same.
                        </DialogDescription>
                    </ModalField>
                </div>
                <ModalFooter>
                    <ModalButton
                        onClick={() => { onOpenChange(false); }}
                        disabled={mutation.isPending}
                    >
                        Cancel
                    </ModalButton>
                    <ModalButton type="submit" tone="primary" disabled={!canSave}>
                        {mutation.isPending ? "Renaming…" : "Rename"}
                    </ModalButton>
                </ModalFooter>
            </form>
        </>
    );
}

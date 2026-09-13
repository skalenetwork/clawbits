import {useState} from "react";
import {useNavigate} from "react-router-dom";
import {useMutation, useQueryClient} from "@tanstack/react-query";
import {ModalDirectory, ModalHeader, ModalPanel, ModalSearch} from "@/components/modals/Modal";
import {useOrgDirectory, type DirectoryEntry} from "@/components/modals/useOrgDirectory";
import {useAuth} from "@/context/AuthContext";
import {createOrGetMmDirect} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";

export function NewDmDialog({open, onOpenChange}: {open: boolean; onOpenChange: (open: boolean) => void}) {
    const {activeOrgId} = useAuth();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [query, setQuery] = useState("");
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (!open) setQuery("");
    }

    const directory = useOrgDirectory({enabled: open, needle: query, dmOnly: true});

    const openDmMutation = useMutation({
        mutationFn: (e: DirectoryEntry) => createOrGetMmDirect(activeOrgId ?? "", e.kind, e.id),
        onSuccess: channel => {
            onOpenChange(false);
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            void navigate(`/channels/${channel.channel_id}`);
        },
        onError: e => {
            toast.error(errMsg(e, "Couldn't start direct message"));
        },
    });

    const pendingKey = openDmMutation.isPending ? openDmMutation.variables.key : null;

    return (
        <ModalPanel open={open} onOpenChange={onOpenChange} kind="picker">
            <ModalHeader
                title="New direct message"
                description="Pick anyone in your organization to start a private conversation."
            >
                <ModalSearch
                    value={query}
                    onChange={setQuery}
                    placeholder="Search agents and people"
                    disabled={openDmMutation.isPending}
                />
            </ModalHeader>
            <ModalDirectory
                {...directory}
                disabled={openDmMutation.isPending}
                note={e => (pendingKey === e.key ? "Opening…" : undefined)}
                onSelect={e => { openDmMutation.mutate(e); }}
            />
        </ModalPanel>
    );
}

import {useState} from "react";
import {useNavigate} from "react-router-dom";
import {useMutation, useQueryClient} from "@tanstack/react-query";
import {ModalDirectory, ModalHeader, ModalPanel, ModalSearch} from "@/components/modals/Modal";
import {useOrgDirectory, type DirectoryEntry} from "@/components/modals/useOrgDirectory";
import {useAuth} from "@/context/AuthContext";
import {createMmAgentChat, createOrGetMmDirect} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";

export function NewDmDialog({
    open, onOpenChange, named = false,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    named?: boolean;
}) {
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
    const sections = named ? directory.sections.filter(s => s.label === "Agents") : directory.sections;

    const openMutation = useMutation({
        mutationFn: (e: DirectoryEntry) => named
            ? createMmAgentChat(activeOrgId ?? "", e.id)
            : createOrGetMmDirect(activeOrgId ?? "", e.kind, e.id),
        onSuccess: channel => {
            onOpenChange(false);
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            void navigate(`/channels/${channel.channel_id}`);
        },
        onError: e => {
            toast.error(errMsg(e, named ? "Couldn't start chat" : "Couldn't start direct message"));
        },
    });

    const pendingKey = openMutation.isPending ? openMutation.variables.key : null;

    return (
        <ModalPanel open={open} onOpenChange={onOpenChange} kind="picker">
            <ModalHeader
                title={named ? "New agent chat" : "New direct message"}
                description={named
                    ? "Always a new session — not the inbox."
                    : "Pick anyone in your organization to start a private conversation."}
            >
                <ModalSearch
                    value={query}
                    onChange={setQuery}
                    placeholder={named ? "Search agents" : "Search agents and people"}
                    disabled={openMutation.isPending}
                />
            </ModalHeader>
            <ModalDirectory
                {...directory}
                sections={sections}
                disabled={openMutation.isPending}
                note={e => (pendingKey === e.key ? "Opening…" : undefined)}
                onSelect={e => { openMutation.mutate(e); }}
            />
        </ModalPanel>
    );
}

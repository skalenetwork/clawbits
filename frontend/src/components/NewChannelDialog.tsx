import {useState} from "react";
import {useNavigate} from "react-router-dom";
import {useMutation, useQueryClient} from "@tanstack/react-query";
import {
    Tick01Icon as Check,
    HashtagIcon as Hash,
    LockIcon as Lock,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {Scrim} from "@/components/ProgressiveBlur";
import {
    ModalButton,
    ModalDirectory,
    ModalField,
    ModalFooter,
    ModalHeader,
    ModalPanel,
    ModalSearch,
    ModalTabs,
    type ModalTab,
} from "@/components/modals/Modal";
import {useOrgDirectory} from "@/components/modals/useOrgDirectory";
import {Input} from "@/components/ui/input";
import {useAuth} from "@/context/AuthContext";
import {addMmChannelMember, createMmChannel} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {toast} from "@/lib/toast";

const QUIET = "text-[12px] text-muted-foreground";

type Visibility = "public" | "private";

const VISIBILITY: readonly ModalTab<Visibility>[] = [
    {id: "public", label: "Public", icon: Hash},
    {id: "private", label: "Private", icon: Lock},
];

const SELECTED_NOTE = (
    <>
        <Icon icon={Check} className="size-3.5 text-foreground"/>
        <span className="sr-only">Selected</span>
    </>
);

export function NewChannelDialog({open, onOpenChange}: {open: boolean; onOpenChange: (open: boolean) => void}) {
    const {activeOrgId} = useAuth();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [name, setName] = useState("");
    const [visibility, setVisibility] = useState<Visibility>("public");
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (!open) {
            setName("");
            setVisibility("public");
            setQuery("");
            setSelected(new Set());
        }
    }

    const directory = useOrgDirectory({enabled: open, needle: query});

    const createChannelMutation = useMutation({
        mutationFn: async (displayName: string) => {
            if (!activeOrgId) throw new Error("No active organization");
            const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
            const channel = await createMmChannel(
                activeOrgId,
                slug || `channel-${String(Date.now())}`,
                displayName,
                visibility,
            );
            for (const e of directory.all.filter(i => selected.has(i.key))) {
                await addMmChannelMember(channel.channel_id, e.id, e.kind);
            }
            return channel;
        },
        onSuccess: channel => {
            onOpenChange(false);
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            const created = `Created #${channel.display_name ?? channel.name}`;
            toast.success(selected.size > 0 ? `${created} · invited ${String(selected.size)}` : created);
            void navigate(`/channels/${channel.channel_id}`);
        },
    });

    const trimmed = name.trim();
    const submitting = createChannelMutation.isPending;

    return (
        <ModalPanel open={open} onOpenChange={onOpenChange} kind="form">
            <ModalHeader
                title="Create channel"
                description="Channels organize conversations around a topic. Invite people now or add them later."
            />
            <form
                onSubmit={e => {
                    e.preventDefault();
                    if (trimmed) createChannelMutation.mutate(trimmed);
                }}
            >
                <div className="flex flex-col gap-4 p-4">
                    <ModalField label="Channel name" htmlFor="new-channel-name">
                        <Input
                            id="new-channel-name"
                            autoFocus
                            value={name}
                            onChange={e => { setName(e.target.value); }}
                            placeholder="e.g. general"
                            maxLength={64}
                            disabled={submitting}
                        />
                    </ModalField>
                    <ModalField label="Visibility">
                        <ModalTabs
                            tabs={VISIBILITY}
                            value={visibility}
                            onChange={setVisibility}
                            label="Visibility"
                            disabled={submitting}
                        />
                        <p className={QUIET}>
                            {visibility === "public" ? "Anyone in the org can join" : "Invite-only"}
                        </p>
                    </ModalField>
                </div>

                <div className="sticky top-12 z-10">
                    <Scrim color="popover" inset/>
                    <div className="flex items-baseline justify-between gap-2 px-4 pt-3 pb-1.5">
                        <span className="text-[12px] font-medium text-muted-foreground">Invite people</span>
                        {selected.size > 0 && <span className={QUIET}>{selected.size} selected</span>}
                    </div>
                    <ModalSearch
                        value={query}
                        onChange={setQuery}
                        placeholder="Search agents and people"
                        autoFocus={false}
                        disabled={submitting}
                    />
                </div>
                <ModalDirectory
                    {...directory}
                    disabled={submitting}
                    note={e => (selected.has(e.key) ? SELECTED_NOTE : undefined)}
                    onSelect={e => {
                        setSelected(prev => {
                            const next = new Set(prev);
                            if (!next.delete(e.key)) next.add(e.key);
                            return next;
                        });
                    }}
                />

                <ModalFooter>
                    <ModalButton onClick={() => { onOpenChange(false); }} disabled={submitting}>
                        Cancel
                    </ModalButton>
                    <ModalButton type="submit" tone="primary" disabled={!trimmed || submitting}>
                        {submitting ? "Creating…" : "Create channel"}
                    </ModalButton>
                </ModalFooter>
            </form>
        </ModalPanel>
    );
}

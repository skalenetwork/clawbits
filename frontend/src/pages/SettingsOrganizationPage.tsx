import {lazy, Suspense, useState} from "react";
import {useMutation, useQueryClient} from "@tanstack/react-query";
import {Building03Icon as OrgIcon, LockIcon as Lock} from "@hugeicons/core-free-icons";
import {Avatar} from "@/components/Avatar";
import {EmptyState} from "@/components/EmptyState";
import {PageHeader} from "@/components/PageHeader";
import {SettingsPage, SettingsRow, SettingsSection} from "@/components/settings/Settings";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {removeOrgAvatar, updateOrg, uploadOrgAvatar, type Org} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";

const AvatarEditorDialog = lazy(() =>
    import("@/components/settings/AvatarEditorDialog").then(m => ({default: m.AvatarEditorDialog})),
);

const NAME_MAX_LENGTH = 128;

function NameForm({org, saved, onSaved}: {org: Org; saved: string; onSaved: () => Promise<void>}) {
    const [draft, setDraft] = useState(saved);
    const mutation = useMutation({
        mutationFn: (name: string) => updateOrg(org.org_id, name),
        onSuccess: async () => {
            await onSaved();
            toast.success("Name saved");
        },
        onError: err => { toast.error(errMsg(err, "Couldn't save name")); },
    });
    const trimmed = draft.trim();
    const canSave = trimmed !== "" && trimmed !== saved && !mutation.isPending;

    return (
        <form
            className="flex items-center gap-2"
            onSubmit={e => {
                e.preventDefault();
                if (canSave) mutation.mutate(trimmed);
            }}
        >
            <Input
                id="org-display-name"
                size="sm"
                value={draft}
                maxLength={NAME_MAX_LENGTH}
                disabled={mutation.isPending}
                onChange={e => { setDraft(e.target.value); }}
            />
            <Button type="submit" size="sm" disabled={!canSave}>
                {mutation.isPending ? "Saving…" : "Save"}
            </Button>
        </form>
    );
}

export default function SettingsOrganizationPage() {
    const {org, isOwner, isLoading} = useActiveOrg();
    const queryClient = useQueryClient();
    const [editorOpen, setEditorOpen] = useState(false);
    const refresh = () => queryClient.invalidateQueries({queryKey: queryKeys.orgs});

    const removeMutation = useMutation({
        mutationFn: removeOrgAvatar,
        onSuccess: async () => {
            await refresh();
            toast.success("Picture removed");
        },
        onError: err => { toast.error(errMsg(err, "Couldn't remove picture")); },
    });

    if (isLoading || !org) return null;

    if (!isOwner) {
        return (
            <>
                <PageHeader icon={OrgIcon} title="General"/>
                <EmptyState
                    icon={Lock}
                    title="Admins only"
                    description="Only organization admins can change its name and picture."
                />
            </>
        );
    }

    const name = org.display_name ?? org.name;

    return (
        <SettingsPage>
            <PageHeader icon={OrgIcon} title="General"/>

            <SettingsSection label="Organization">
                <SettingsRow
                    leading={<Avatar src={org.avatar?.url} name={name} size={44} className="rounded-xl"/>}
                    title={name}
                    description={org.name}
                    control={
                        <>
                            {org.avatar && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={removeMutation.isPending}
                                    onClick={() => { removeMutation.mutate(org.org_id); }}
                                >
                                    {removeMutation.isPending ? "Removing…" : "Remove"}
                                </Button>
                            )}
                            <Button variant="outline" size="sm" onClick={() => { setEditorOpen(true); }}>
                                Change picture
                            </Button>
                        </>
                    }
                />
                <SettingsRow
                    title="Name"
                    description="Shown to everyone in the organization"
                    htmlFor="org-display-name"
                    control={<NameForm key={name} org={org} saved={name} onSaved={refresh}/>}
                />
            </SettingsSection>

            {editorOpen && (
                <Suspense fallback={null}>
                    <AvatarEditorDialog
                        open
                        onOpenChange={setEditorOpen}
                        title="Change organization picture"
                        name={name}
                        src={org.avatar?.url}
                        onUpload={blob => uploadOrgAvatar(org.org_id, blob).then(refresh)}
                    />
                </Suspense>
            )}
        </SettingsPage>
    );
}

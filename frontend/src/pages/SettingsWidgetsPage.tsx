import {useState} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {ChessPawnIcon, LockIcon as Lock} from "@hugeicons/core-free-icons";
import {EmptyState} from "@/components/EmptyState";
import {PageHeader} from "@/components/PageHeader";
import {SettingsPage, SettingsRow, SettingsRowSkeleton, SettingsSection} from "@/components/settings/Settings";
import {Button} from "@/components/ui/button";
import {Switch} from "@/components/ui/switch";
import {useAuth} from "@/context/AuthContext";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {endActiveWidgets, getOrgWidgets, setOrgWidgets} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";

/** The org's widgets switch. It can't turn off under an active widget, so the page offers to end them. */
export default function SettingsWidgetsPage() {
    const {activeOrgId} = useAuth();
    const {isOwner, isLoading: roleLoading} = useActiveOrg();
    const queryClient = useQueryClient();
    const [confirmEnd, setConfirmEnd] = useState(false);

    const settingsQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.orgWidgets(activeOrgId) : ["org", "none", "widgets"],
        queryFn: () => getOrgWidgets(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && isOwner,
    });
    const settings = settingsQuery.data;

    const save = useMutation({
        mutationFn: ({orgId, enabled}: {orgId: string; enabled: boolean}) => setOrgWidgets(orgId, enabled),
        onSuccess: (data, {orgId}) => {
            queryClient.setQueryData(queryKeys.orgWidgets(orgId), data);
            void queryClient.invalidateQueries({queryKey: queryKeys.orgs});
        },
        // A refusal can mean the session now belongs to someone else (dev sign-ins share one cookie across
        // tabs): re-read the role too, so the page shows what the server sees instead of a stale admin view.
        onError: (err, {orgId}) => {
            toast.error(errMsg(err, "Couldn't change widgets"));
            void queryClient.invalidateQueries({queryKey: queryKeys.orgWidgets(orgId)});
            void queryClient.invalidateQueries({queryKey: queryKeys.orgs});
        },
    });
    const endAll = useMutation({
        mutationFn: (orgId: string) => endActiveWidgets(orgId),
        onSuccess: ({ended}, orgId) => {
            setConfirmEnd(false);
            toast.success(ended === 1 ? "Ended 1 widget" : `Ended ${String(ended)} widgets`);
            void queryClient.invalidateQueries({queryKey: queryKeys.orgWidgets(orgId)});
        },
        onError: (err) => {
            toast.error(errMsg(err, "Couldn't end widgets"));
            void queryClient.invalidateQueries({queryKey: queryKeys.orgs});
        },
    });

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }
    if (roleLoading) {
        return <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>;
    }
    if (!isOwner) {
        return (
            <>
                <PageHeader icon={ChessPawnIcon} title="Widgets"/>
                <EmptyState
                    icon={Lock}
                    title="Admins only"
                    description="Widget settings are restricted to organization admins."
                />
            </>
        );
    }

    const active = settings?.active_count ?? 0;
    return (
        <>
            <PageHeader icon={ChessPawnIcon} title="Widgets"/>
            <SettingsPage>
                {settingsQuery.isLoading && (
                    <SettingsSection>
                        <SettingsRowSkeleton leading={false}/>
                    </SettingsSection>
                )}
                {settingsQuery.isError && (
                    <SettingsSection>
                        <SettingsRow
                            title="Couldn't load widget settings"
                            error={errMsg(settingsQuery.error, "Failed to load widget settings")}
                        />
                    </SettingsSection>
                )}
                {settings && (
                    <SettingsSection
                        footer="A chat runs widgets only when its own switch is on too, in Channel info. Moves never send notifications."
                    >
                        <SettingsRow
                            title="Widgets in chats"
                            description="Chess, battleship, poker and blackjack in one-to-one chats between people"
                            htmlFor="widgets-enabled"
                            control={
                                <Switch
                                    id="widgets-enabled"
                                    checked={settings.enabled}
                                    disabled={save.isPending || (settings.enabled && active > 0)}
                                    onCheckedChange={(next) => { save.mutate({orgId: activeOrgId, enabled: next}); }}
                                />
                            }
                        />
                        {active > 0 && (
                            <SettingsRow
                                title={active === 1 ? "1 widget is active" : `${String(active)} widgets are active`}
                                description="Widgets can't be turned off while one is active"
                                control={
                                    confirmEnd ? (
                                        <>
                                            <Button size="sm" variant="ghost" onClick={() => { setConfirmEnd(false); }}>
                                                Cancel
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="destructive"
                                                disabled={endAll.isPending}
                                                onClick={() => { endAll.mutate(activeOrgId); }}
                                            >
                                                End {active === 1 ? "it" : "all"}
                                            </Button>
                                        </>
                                    ) : (
                                        <Button size="sm" variant="outline" onClick={() => { setConfirmEnd(true); }}>
                                            End all
                                        </Button>
                                    )
                                }
                            />
                        )}
                    </SettingsSection>
                )}
            </SettingsPage>
        </>
    );
}

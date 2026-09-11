import { lazy, Suspense, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { UserIcon as User } from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { SettingsPage, SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { UserAvatar } from "@/components/UserAvatar";
import { useAuth } from "@/context/AuthContext";
import { deleteMyAccount, resetOwnAvatar, updateMyProfile } from "@/lib/api";
import { formatLastSeen } from "@/lib/formatting";
import { errMsg, toast } from "@/lib/toast";
import { confirm } from "@/lib/confirm";

const AvatarEditorDialog = lazy(() =>
    import("@/components/settings/AvatarEditorDialog").then(m => ({
        default: m.AvatarEditorDialog,
    })),
);

// Keep in sync with DISPLAY_NAME_MAX_LENGTH in clawbits/db/models.py.
const DISPLAY_NAME_MAX_LENGTH = 32;

const VALUE = "truncate text-[13px] text-muted-foreground";

function formatJoined(ts: string | null | undefined): string {
    const d = new Date(ts ?? "");
    return Number.isNaN(d.getTime())
        ? "Unknown"
        : d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

export default function SettingsProfilePage() {
    const { user, applyProfileUpdate, logout } = useAuth();
    const navigate = useNavigate();
    const [editorOpen, setEditorOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const resetMutation = useMutation({
        mutationFn: resetOwnAvatar,
        onSuccess: (avatar) => {
            if (!user) return;
            applyProfileUpdate({ ...user, avatar });
            toast.success("Profile picture reset to default");
        },
        onError: (err) => {
            toast.error(errMsg(err, "Couldn't reset profile picture"));
        },
    });

    if (!user) return null;

    const saveDisplayName = async (raw: string) => {
        const trimmed = raw.trim();
        if (trimmed === (user.display_name ?? "")) return;
        setSaving(true);
        try {
            applyProfileUpdate(await updateMyProfile(trimmed === "" ? null : trimmed));
            toast.success("Display name saved");
        } catch (err) {
            toast.error(errMsg(err, "Failed to save profile"));
        } finally {
            setSaving(false);
        }
    };

    const handleSignOut = async () => {
        try {
            await logout();
            void navigate("/login");
        } catch (err) {
            toast.error(errMsg(err, "Sign-out failed"));
        }
    };

    const handleDeleteAccount = async () => {
        const ok = await confirm({
            title: "Delete your account?",
            description:
                "This permanently deletes your account and all of your data: "
                + "messages, reactions, files, and any chat where you're the "
                + "only person. This cannot be undone.",
            confirmLabel: "Delete account",
        });
        if (!ok) return;
        setDeleting(true);
        try {
            await deleteMyAccount();
            // Full reload onto the logged-out surface: the server cleared the session cookies.
            window.location.href = "/login";
        } catch (err) {
            toast.error(errMsg(err, "Couldn't delete account"));
            setDeleting(false);
        }
    };

    const name = user.display_name ?? user.email;

    return (
        <div>
            <PageHeader icon={User} title="Profile" />

            <SettingsPage>
                <SettingsSection>
                    <SettingsRow
                        leading={<UserAvatar src={user.avatar?.url} name={name} size={44} />}
                        title={name}
                        description={user.email}
                        control={
                            <>
                                {user.avatar?.kind === "uploaded" && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={resetMutation.isPending}
                                        onClick={() => { resetMutation.mutate(); }}
                                    >
                                        {resetMutation.isPending ? "Resetting…" : "Reset"}
                                    </Button>
                                )}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => { setEditorOpen(true); }}
                                >
                                    Change picture
                                </Button>
                            </>
                        }
                    />
                </SettingsSection>

                <SettingsSection label="Identity">
                    <SettingsRow
                        title="Display name"
                        description="Leave blank to show your email"
                        htmlFor="profile-display-name"
                        control={
                            <Input
                                key={user.display_name ?? ""}
                                id="profile-display-name"
                                size="sm"
                                defaultValue={user.display_name ?? ""}
                                placeholder="How others see you"
                                maxLength={DISPLAY_NAME_MAX_LENGTH}
                                disabled={saving}
                                onBlur={(e) => { void saveDisplayName(e.currentTarget.value); }}
                                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                            />
                        }
                    />
                    <SettingsRow
                        title="Email"
                        description="Contact support to change it"
                        control={<span className={VALUE}>{user.email}</span>}
                    />
                </SettingsSection>

                <SettingsSection label="Account">
                    <SettingsRow
                        title="Member since"
                        control={<span className={VALUE}>{formatJoined(user.created_at)}</span>}
                    />
                    <SettingsRow
                        title="Last active"
                        control={<span className={VALUE}>{formatLastSeen(user.last_seen_at)}</span>}
                    />
                    <SettingsRow
                        title="User ID"
                        control={<span className={`${VALUE} font-mono`}>{user.id}</span>}
                    />
                    <SettingsRow
                        title="Sign out"
                        description="End this session on this device"
                        control={
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => { void handleSignOut(); }}
                            >
                                Sign out
                            </Button>
                        }
                    />
                </SettingsSection>

                <SettingsSection label="Danger zone">
                    <SettingsRow
                        title="Delete account"
                        description="Removes your account and its data. Hand off agents and orgs first"
                        control={
                            <Button
                                variant="destructive"
                                size="sm"
                                disabled={deleting}
                                onClick={() => { void handleDeleteAccount(); }}
                            >
                                {deleting ? "Deleting…" : "Delete"}
                            </Button>
                        }
                    />
                </SettingsSection>
            </SettingsPage>

            {editorOpen && (
                <Suspense fallback={null}>
                    <AvatarEditorDialog
                        open={editorOpen}
                        onOpenChange={setEditorOpen}
                        user={user}
                    />
                </Suspense>
            )}
        </div>
    );
}

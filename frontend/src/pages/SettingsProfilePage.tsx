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
import { deleteMyAccount, resetOwnAvatar, updateMyProfile, uploadOwnAvatar } from "@/lib/api";
import { formatLastSeen } from "@/lib/formatting";
import { errMsg, toast } from "@/lib/toast";
import { confirm } from "@/lib/confirm";

const AvatarEditorDialog = lazy(() =>
    import("@/components/settings/AvatarEditorDialog").then(m => ({ default: m.AvatarEditorDialog })),
);

// Keep in sync with DISPLAY_NAME_MAX_LENGTH in clawbits/db/models.py.
const DISPLAY_NAME_MAX_LENGTH = 32;

const VALUE = "truncate text-[13px] text-muted-foreground";

function DisplayNameForm({ saved }: { saved: string }) {
    const { applyProfileUpdate } = useAuth();
    const [draft, setDraft] = useState(saved);

    const mutation = useMutation({
        mutationFn: (name: string) => updateMyProfile(name === "" ? null : name),
        onSuccess: (profile) => {
            applyProfileUpdate(profile);
            toast.success("Display name saved");
        },
        onError: (err) => {
            toast.error(errMsg(err, "Failed to save profile"));
        },
    });

    const trimmed = draft.trim();
    const canSave = trimmed !== saved && !mutation.isPending;

    return (
        <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
                e.preventDefault();
                if (canSave) mutation.mutate(trimmed);
            }}
        >
            <Input
                id="profile-display-name"
                size="sm"
                value={draft}
                placeholder="How others see you"
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                disabled={mutation.isPending}
                onChange={(e) => { setDraft(e.target.value); }}
            />
            <Button type="submit" size="sm" disabled={!canSave}>
                {mutation.isPending ? "Saving…" : "Save"}
            </Button>
        </form>
    );
}

export default function SettingsProfilePage() {
    const { user, applyProfileUpdate, logout } = useAuth();
    const navigate = useNavigate();
    const [editorOpen, setEditorOpen] = useState(false);
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
                "This permanently deletes your account and all of your data: messages, reactions, files, and any chat where you're the only person. This cannot be undone.",
            confirmLabel: "Delete account",
        });
        if (!ok) return;
        setDeleting(true);
        try {
            await deleteMyAccount();
            // A full reload, not navigate: the server cleared the session cookies.
            window.location.href = "/login";
        } catch (err) {
            toast.error(errMsg(err, "Couldn't delete account"));
            setDeleting(false);
        }
    };

    const name = user.display_name ?? user.email;
    const joined = new Date(user.created_at ?? "");

    return (
        <SettingsPage>
            <PageHeader icon={User} title="Profile" />

            <SettingsSection label="Profile picture">
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
                            <Button variant="outline" size="sm" onClick={() => { setEditorOpen(true); }}>
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
                    control={<DisplayNameForm key={user.display_name ?? ""} saved={user.display_name ?? ""} />}
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
                    control={
                        <span className={VALUE}>
                            {Number.isNaN(joined.getTime())
                                ? "Unknown"
                                : joined.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
                        </span>
                    }
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
                        <Button variant="outline" size="sm" onClick={() => { void handleSignOut(); }}>
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

            {editorOpen && (
                <Suspense fallback={null}>
                    <AvatarEditorDialog
                        open
                        onOpenChange={setEditorOpen}
                        title="Change profile picture"
                        name={name}
                        src={user.avatar?.url}
                        onUpload={blob => uploadOwnAvatar(blob).then(avatar => { applyProfileUpdate({ ...user, avatar }); })}
                    />
                </Suspense>
            )}
        </SettingsPage>
    );
}

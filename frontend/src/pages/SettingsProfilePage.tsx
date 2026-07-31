import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import {
    UserIcon as User,
    Camera01Icon as CameraIcon,
    Logout01Icon as LogOutIcon,
    RefreshIcon as RefreshIcon,
    Delete02Icon as TrashIcon,
} from "@hugeicons/core-free-icons";

import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/Icon";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { useAuth } from "@/context/AuthContext";
import { deleteMyAccount, resetOwnAvatar, updateMyProfile } from "@/lib/api";
import { formatLastSeen } from "@/lib/formatting";
import { errMsg, toast } from "@/lib/toast";
import { confirm } from "@/lib/confirm";

// Lazy-load the editor — it pulls in ``react-easy-crop`` for the
// pan/zoom UI, which we don't want in the main settings chunk.
const AvatarEditorDialog = lazy(() =>
    import("@/components/settings/AvatarEditorDialog").then(m => ({
        default: m.AvatarEditorDialog,
    })),
);

// Hard cap on the display name. Keep in sync with DISPLAY_NAME_MAX_LENGTH
// in clawbits/db/models.py (enforced server-side too).
const DISPLAY_NAME_MAX_LENGTH = 32;

function formatJoined(ts: string | null | undefined): string {
    if (!ts) return "—";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

export default function SettingsProfilePage() {
    const { user, applyProfileUpdate, logout } = useAuth();
    const navigate = useNavigate();
    const [displayName, setDisplayName] = useState(user?.display_name ?? "");
    const [editorOpen, setEditorOpen] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        setDisplayName(user?.display_name ?? "");
    }, [user?.display_name]);

    const dirty = (user?.display_name ?? "") !== displayName.trim();
    const hasCustomAvatar = user?.avatar?.kind === "uploaded";

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

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!dirty) return;
        setSaving(true);
        try {
            const trimmed = displayName.trim();
            const updated = await updateMyProfile(trimmed === "" ? null : trimmed);
            applyProfileUpdate(updated);
            toast.success("Profile updated");
        } catch (err) {
            toast.error(errMsg(err, "Failed to save profile"));
        } finally {
            setSaving(false);
        }
    };

    const handleSignOut = async () => {
        try {
            await logout();
            navigate("/login");
        } catch (err) {
            toast.error(errMsg(err, "Sign-out failed"));
        }
    };

    const [deleting, setDeleting] = useState(false);
    const handleDeleteAccount = async () => {
        const ok = await confirm({
            title: "Delete your account?",
            description:
                "This permanently deletes your account and all of your data — "
                + "messages, reactions, files, and any chat where you're the "
                + "only person. This cannot be undone.",
            confirmLabel: "Delete account",
        });
        if (!ok) return;
        setDeleting(true);
        try {
            await deleteMyAccount();
            // The server cleared the session cookies; do a full reload onto the
            // logged-out surface so no stale auth state remains.
            window.location.href = "/login";
        } catch (err) {
            // 409 when the user still operates agents or solely owns an org —
            // the message says what to resolve first.
            toast.error(errMsg(err, "Couldn't delete account"));
            setDeleting(false);
        }
    };

    if (!user) {
        return <div className="text-sm text-muted-foreground">Loading…</div>;
    }

    const fallbackName = user.display_name ?? user.email;

    return (
        <div>
            <PageHeader icon={User} title="Profile" />

            {/* Sub-sections are separated by divider lines + spacing rather than
                nested cards — the content card itself is the surface. */}
            <div className="divide-y divide-border/60">
            {/* Hero — avatar + identity + edit affordances. */}
            <section className="py-6 first:pt-0">
                <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
                    <div className="relative shrink-0">
                        <Avatar
                            src={user.avatar?.url}
                            name={fallbackName}
                            size={88}
                            className="rounded-xl"
                        />
                        <button
                            type="button"
                            aria-label="Change profile picture"
                            onClick={() => { setEditorOpen(true); }}
                            className="absolute -bottom-1.5 -right-1.5 grid size-7 place-items-center rounded-full bg-background text-foreground shadow-sm ring-1 ring-border/60 transition-colors hover:bg-muted"
                        >
                            <Icon icon={CameraIcon} className="size-3.5"/>
                        </button>
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-base font-semibold">{fallbackName}</p>
                        <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                            <Button
                                type="button"
                                size="sm"
                                onClick={() => { setEditorOpen(true); }}
                            >
                                <Icon icon={CameraIcon} className="size-4"/>
                                Change avatar
                            </Button>
                            {hasCustomAvatar && (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={resetMutation.isPending}
                                    onClick={() => { resetMutation.mutate(); }}
                                >
                                    <Icon icon={RefreshIcon} className="size-4"/>
                                    {resetMutation.isPending ? "Resetting…" : "Reset to default"}
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </section>

            {/* Identity — editable display name + locked email. */}
            <form onSubmit={handleSave} className="space-y-5 py-6">
                <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold">Identity</h2>
                    <p className="text-xs text-muted-foreground">
                        How others see you in channels, mentions, and member lists.
                    </p>
                </div>

                <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                        <label htmlFor="profile-display-name" className="text-xs font-medium text-muted-foreground">
                            Display name
                        </label>
                        <span
                            className={`text-xs tabular-nums ${
                                displayName.length >= DISPLAY_NAME_MAX_LENGTH
                                    ? "text-destructive"
                                    : "text-muted-foreground"
                            }`}
                            aria-live="polite"
                        >
                            {displayName.length}/{DISPLAY_NAME_MAX_LENGTH}
                        </span>
                    </div>
                    <Input
                        id="profile-display-name"
                        value={displayName}
                        onChange={(e) => { setDisplayName(e.target.value); }}
                        placeholder="How others see you"
                        maxLength={DISPLAY_NAME_MAX_LENGTH}
                        disabled={saving}
                    />
                    <p className="text-xs text-muted-foreground">
                        Leave blank to show your email instead.
                    </p>
                </div>

                <div className="space-y-1.5">
                    <label htmlFor="profile-email" className="text-xs font-medium text-muted-foreground">
                        Email address
                    </label>
                    <Input id="profile-email" value={user.email} disabled readOnly className="font-mono"/>
                    <p className="text-xs text-muted-foreground">
                        Contact support to change your email.
                    </p>
                </div>

                <div className="flex items-center gap-3">
                    <Button type="submit" disabled={!dirty || saving}>
                        {saving ? "Saving…" : "Save changes"}
                    </Button>
                </div>
            </form>

            {/* Account — read-only meta + sign-out. */}
            <section className="space-y-5 py-6">
                <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold">Account</h2>
                    <p className="text-xs text-muted-foreground">
                        Snapshot of this account on Clawbits.
                    </p>
                </div>

                <dl className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-0.5">
                        <dt className="text-xs font-medium text-muted-foreground">Member since</dt>
                        <dd className="text-sm font-medium">{formatJoined(user.created_at ?? null)}</dd>
                    </div>
                    <div className="space-y-0.5">
                        <dt className="text-xs font-medium text-muted-foreground">Last active</dt>
                        <dd className="text-sm font-medium">{formatLastSeen(user.last_seen_at ?? null)}</dd>
                    </div>
                    <div className="space-y-0.5">
                        <dt className="text-xs font-medium text-muted-foreground">User ID</dt>
                        <dd className="font-mono text-sm">{user.id}</dd>
                    </div>
                </dl>

                <div className="flex items-center gap-3 border-t border-border/40 pt-4">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => { void handleSignOut(); }}
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                        <Icon icon={LogOutIcon} className="size-4"/>
                        Sign out
                    </Button>
                </div>
            </section>

            {/* Danger zone — permanent, irreversible account deletion. */}
            <section className="space-y-4 py-6">
                <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold text-destructive">Danger zone</h2>
                    <p className="text-xs text-muted-foreground">
                        Permanently delete your account and all of your data. If
                        you operate agents or solely own a shared organization,
                        hand those off first.
                    </p>
                </div>
                <div className="flex items-center gap-3 border-t border-destructive/20 pt-4">
                    <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={deleting}
                        onClick={() => { void handleDeleteAccount(); }}
                    >
                        <Icon icon={TrashIcon} className="size-4"/>
                        {deleting ? "Deleting…" : "Delete account"}
                    </Button>
                </div>
            </section>
            </div>

            {/* Only mount the dialog (and thus pay the lazy chunk cost)
                once the user actually opens it. */}
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

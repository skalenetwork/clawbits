import { useEffect, useState, type ReactNode } from "react";
import {
    Notification03Icon as Bell,
    SquareArrowUp01Icon as ShareUp,
} from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { SettingsPage, SettingsRow, SettingsSection, SettingsStatus } from "@/components/settings/Settings";
import { usePushSubscription, type PushUiStatus } from "@/lib/push";
import {
    getNotificationDiagnostics,
    isDesktop,
    sendTestNotification,
    type NotificationDiagnostics,
} from "@/lib/desktop";
import { toast } from "@/lib/toast";

const PUSH_DESCRIPTION: Record<Exclude<PushUiStatus, "install-required">, string> = {
    loading: "Get a banner for new messages here",
    prompt: "Get a banner for new messages here",
    enabled: "You'll be notified on this device",
    denied: "Blocked in your browser. Allow notifications for this site, then reload",
    unsupported: "This browser doesn't support push notifications",
    unavailable: "Push notifications aren't enabled on this server yet",
};

export default function SettingsNotificationsPage() {
    const push = usePushSubscription();
    const diagnostics = useNotificationDiagnostics();
    const [testing, setTesting] = useState(false);

    const handleTest = async () => {
        setTesting(true);
        try {
            await sendTestNotification();
            // Not "delivered": the shell accepting it says nothing about a Linux daemon dropping it.
            toast.success("Test sent, a banner should appear shortly");
        } catch {
            toast.error("Couldn't send a test notification");
        } finally {
            setTesting(false);
        }
    };

    const handleToggle = async (next: boolean) => {
        if (!next) {
            await push.disable();
            toast.success("Notifications turned off");
            return;
        }
        const result = await push.enable();
        if (result === "enabled") {
            toast.success("Notifications enabled on this device");
        } else if (result === "denied") {
            toast.error("Notifications permission was denied");
        } else if (result === "unavailable") {
            toast.error("Push notifications aren't available right now");
        } else {
            toast.error("This browser doesn't support notifications");
        }
    };

    return (
        <SettingsPage>
            <PageHeader icon={Bell} title="Notifications" />
            <SettingsSection
                label="Push notifications"
                footer={deliveryReport(diagnostics)}
            >
                {isDesktop ? (
                    <SettingsRow
                        title="System notifications"
                        description="Uses your system notifications. Send a test to check they arrive"
                        control={
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={testing}
                                onClick={() => { void handleTest(); }}
                            >
                                Send a test
                            </Button>
                        }
                    />
                ) : push.status === "install-required" ? (
                    <SettingsRow
                        leading={<Icon icon={ShareUp} className="size-5 text-muted-foreground" />}
                        title="Add Clawbits to your Home Screen"
                        description={
                            <>
                                iPhone and iPad only deliver web notifications to the installed
                                app. In Safari, tap Share, choose{" "}
                                <span className="font-medium text-foreground">Add to Home Screen</span>,
                                then open Clawbits from its icon and turn notifications on here.
                                Requires iOS or iPadOS 16.4 or later.
                            </>
                        }
                    />
                ) : (
                    <SettingsRow
                        title="Enable on this device"
                        description={PUSH_DESCRIPTION[push.status]}
                        htmlFor="push-notifications"
                        control={
                            <Switch
                                id="push-notifications"
                                checked={push.status === "enabled"}
                                disabled={
                                    push.busy
                                    || !["prompt", "enabled"].includes(push.status)
                                }
                                onCheckedChange={(next) => { void handleToggle(next); }}
                            />
                        }
                    />
                )}
            </SettingsSection>
        </SettingsPage>
    );
}

// Runs off the render path: on Linux the command waits on the D-Bus notification
// daemon, which is slowest exactly when someone opens this page to debug it.
function useNotificationDiagnostics(): NotificationDiagnostics | null {
    const [diagnostics, setDiagnostics] = useState<NotificationDiagnostics | null>(null);

    useEffect(() => {
        if (!isDesktop) return;
        let live = true;
        void getNotificationDiagnostics().then((result) => {
            if (live) setDiagnostics(result);
        });
        return () => {
            live = false;
        };
    }, []);

    return diagnostics;
}

// Silent on macOS: the OS owns permission state and System Settings says it better.
function deliveryReport(diagnostics: NotificationDiagnostics | null): ReactNode {
    if (diagnostics?.platform !== "linux") return undefined;

    if (diagnostics.error) {
        return (
            <Report tone="bad" title="No notification daemon is answering">
                Your desktop isn&apos;t running a notification service, so nothing can be
                shown. On a minimal window manager, start one yourself: <Term>dunst</Term>{" "}
                and <Term>mako</Term> are common choices.
            </Report>
        );
    }

    if (diagnostics.desktopEntry && !diagnostics.desktopFile) {
        return (
            <Report tone="warn" title="This install isn't registered with your desktop">
                Nothing on this system matches <Term>{diagnostics.desktopEntry}.desktop</Term>,
                and GNOME drops notifications from apps it can&apos;t attribute. Installing
                the <Term>.deb</Term> registers it; an AppImage registers itself on first
                launch, so this usually means it was moved after being run.
            </Report>
        );
    }

    return (
        <Report tone="ok" title={`Delivered by ${diagnostics.serverName ?? "your desktop"}`}>
            Registered as <Term>{diagnostics.desktopEntry ?? "clawbits"}</Term>. If a test
            doesn&apos;t appear, check that Clawbits is allowed in your desktop&apos;s own
            notification settings.
        </Report>
    );
}

function Report({
    tone,
    title,
    children,
}: {
    tone: "ok" | "warn" | "bad";
    title: string;
    children: ReactNode;
}) {
    return (
        <>
            <SettingsStatus tone={tone}>{title}</SettingsStatus>
            <p className="mt-1 leading-relaxed">{children}</p>
        </>
    );
}

function Term({ children }: { children: ReactNode }) {
    return <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{children}</code>;
}

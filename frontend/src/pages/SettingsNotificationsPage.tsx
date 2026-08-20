import { useEffect, useState } from "react";
import {
    Notification03Icon as Bell,
    SquareArrowUp01Icon as ShareUp,
} from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { usePushSubscription } from "@/lib/push";
import {
    getNotificationDiagnostics,
    isDesktop,
    sendTestNotification,
    type NotificationDiagnostics,
} from "@/lib/desktop";
import { toast } from "@/lib/toast";

/**
 * Notifications settings — the web-push opt-in, lifted out of the Profile page
 * into a first-class settings entry (reachable from the desktop sidebar and the
 * mobile "You" menu, same as Appearance / Privacy).
 *
 * The interesting case is iOS: Safari only exposes the Push API inside the
 * Home-Screen app, so a Safari tab can't subscribe. Rather than the misleading
 * "this browser doesn't support notifications", ``usePushSubscription`` reports
 * ``install-required`` there and we show the Add-to-Home-Screen path.
 */
export default function SettingsNotificationsPage() {
    const push = usePushSubscription();
    const diagnostics = useNotificationDiagnostics();
    const [testing, setTesting] = useState(false);

    const handleTest = async () => {
        setTesting(true);
        try {
            await sendTestNotification();
            // Deliberately not "sent!" — the command succeeding only means the
            // shell accepted it. On Linux the daemon can still drop it, and
            // that gap is the whole point of the button.
            toast.success("Test sent - you should see a banner shortly");
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
        <div className="space-y-6">
            <PageHeader icon={Bell} title="Notifications" />

            <section className="space-y-5 rounded-xl border border-border/50 bg-card p-5">
                <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold">Push notifications</h2>
                    <p className="text-xs text-muted-foreground">
                        Alerts for new messages when Clawbits isn&apos;t the focused tab -
                        delivered even when the app is closed.
                    </p>
                </div>

                {/* The control surface adapts to what this runtime can actually do. */}
                {isDesktop ? (
                    <div className="space-y-4 border-t border-border/40 pt-4">
                        <div className="flex items-center gap-4">
                            <div className="min-w-0 flex-1 space-y-0.5">
                                <p className="text-sm font-medium">System notifications</p>
                                <p className="text-xs text-muted-foreground">
                                    Clawbits for desktop uses your system&apos;s own
                                    notifications - nothing to turn on here. Send a test to
                                    check they reach you.
                                </p>
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={testing}
                                onClick={() => { void handleTest(); }}
                            >
                                Send a test
                            </Button>
                        </div>
                        <DesktopDeliveryReport diagnostics={diagnostics} />
                    </div>
                ) : push.status === "install-required" ? (
                    <div className="flex gap-3 rounded-lg border border-border/60 bg-muted/40 p-3.5">
                        <Icon icon={ShareUp} className="size-5 shrink-0 text-muted-foreground" />
                        <div className="space-y-1.5 text-xs text-muted-foreground">
                            <p className="text-sm font-medium text-foreground">
                                Add Clawbits to your Home Screen
                            </p>
                            <p>
                                iPhone and iPad only deliver web notifications to the installed
                                app. In Safari, tap the Share button, choose{" "}
                                <span className="font-medium text-foreground">Add to Home Screen</span>
                                , then open Clawbits from its icon and turn notifications on here.
                            </p>
                            <p className="text-[11px] opacity-80">
                                Requires iOS or iPadOS 16.4 or later.
                            </p>
                        </div>
                    </div>
                ) : push.status === "unsupported" ? (
                    <p className="border-t border-border/40 pt-4 text-xs text-muted-foreground">
                        This browser doesn&apos;t support push notifications.
                    </p>
                ) : push.status === "unavailable" ? (
                    <p className="border-t border-border/40 pt-4 text-xs text-muted-foreground">
                        Push notifications aren&apos;t enabled on this server yet.
                    </p>
                ) : (
                    <div className="flex items-center gap-4 border-t border-border/40 pt-4">
                        <div className="min-w-0 flex-1 space-y-0.5">
                            <p className="text-sm font-medium">Enable on this device</p>
                            <p className="text-xs text-muted-foreground">
                                {push.status === "denied"
                                    ? "Blocked in your browser settings - allow notifications for this site, then reload."
                                    : push.status === "enabled"
                                        ? "You'll be notified on this device."
                                        : "Turn on to get a banner for new messages here."}
                            </p>
                        </div>
                        <Switch
                            id="push-notifications"
                            checked={push.status === "enabled"}
                            disabled={
                                push.busy || push.status === "loading" || push.status === "denied"
                            }
                            onCheckedChange={(next: boolean) => { void handleToggle(next); }}
                        />
                    </div>
                )}
            </section>
        </div>
    );
}

/**
 * Load the shell's notification diagnostics once, on desktop only.
 *
 * On Linux the underlying command talks to the notification daemon over D-Bus
 * and can take a moment when that daemon is slow or absent - which is exactly
 * when a user opens this page - so it runs off the render path and the panel
 * simply shows nothing until it answers.
 */
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

/**
 * What the desktop shell knows about whether notifications can actually be
 * delivered here.
 *
 * All of this was already collected at every boot and written to the log file,
 * where it only helped someone who knew the file existed. Surfacing it turns
 * "notifications don't work" into a report that names the daemon and says
 * whether the desktop environment has anything to attribute us to.
 *
 * Silent on macOS: the OS owns permission state and there is nothing here we
 * could tell the user that System Settings doesn't say better.
 */
function DesktopDeliveryReport({
    diagnostics,
}: {
    diagnostics: NotificationDiagnostics | null;
}) {
    if (diagnostics?.platform !== "linux") return null;

    // Ordered by how badly each one breaks delivery.
    if (diagnostics.error) {
        return (
            <Report tone="warning" title="No notification daemon is answering">
                Your desktop isn&apos;t running a notification service, so nothing can
                be shown. On a minimal window manager you may need to start one
                yourself - <Term>dunst</Term> and <Term>mako</Term> are common choices.
            </Report>
        );
    }

    if (diagnostics.desktopEntry && !diagnostics.desktopFile) {
        return (
            <Report tone="warning" title="This install isn't registered with your desktop">
                Nothing on this system matches{" "}
                <Term>{diagnostics.desktopEntry}.desktop</Term>, and GNOME drops
                notifications from apps it can&apos;t attribute. Installing the{" "}
                <Term>.deb</Term> registers it; an AppImage registers itself on first
                launch, so this usually means it was moved after being run.
            </Report>
        );
    }

    return (
        <Report tone="quiet" title={`Delivered by ${diagnostics.serverName ?? "your desktop"}`}>
            Registered as <Term>{diagnostics.desktopEntry ?? "clawbits"}</Term>. If a
            test doesn&apos;t appear, check that Clawbits is allowed in your desktop&apos;s
            own notification settings.
        </Report>
    );
}

function Report({
    tone,
    title,
    children,
}: {
    tone: "quiet" | "warning";
    title: string;
    children: React.ReactNode;
}) {
    return (
        <div
            className={
                // --destructive, not --signal: index.css fences --signal to
                // navigation intent and forbids it from marking status.
                tone === "warning"
                    ? "space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3.5"
                    : "space-y-1 rounded-lg border border-border/60 bg-muted/40 p-3.5"
            }
        >
            <p className="text-xs font-medium text-foreground">{title}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
        </div>
    );
}

/** Inline literal - a file name, a package, a command. */
function Term({ children }: { children: React.ReactNode }) {
    return <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{children}</code>;
}

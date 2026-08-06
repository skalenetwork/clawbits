import {
    Notification03Icon as Bell,
    SquareArrowUp01Icon as ShareUp,
} from "@hugeicons/core-free-icons";

import { Switch } from "@/components/ui/switch";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { usePushSubscription } from "@/lib/push";
import { isDesktop } from "@/lib/desktop";
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
                    <p className="border-t border-border/40 pt-4 text-xs text-muted-foreground">
                        Clawbits for desktop uses your system&apos;s native notifications -
                        nothing to turn on here.
                    </p>
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

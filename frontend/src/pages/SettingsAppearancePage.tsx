import { useState } from "react";
import {
    PaintBrush01Icon as PaintBrush,
    Sun01Icon as Sun,
    Moon02Icon as Moon,
    ComputerIcon as Monitor,
} from "@hugeicons/core-free-icons";

import { Switch } from "@/components/ui/switch";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { useTheme, type Theme } from "@/hooks/useTheme";
import { useBubbleMode, setBubbleMode } from "@/hooks/useBubbleMode";
import { isDesktop, getStoredAppBgTransparent, setAppBgTransparent } from "@/lib/desktop";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
];

export default function SettingsAppearancePage() {
    const { theme, setTheme } = useTheme();
    const bubbleMode = useBubbleMode();
    const [bgTransparent, setBgTransparent] = useState<boolean>(() => getStoredAppBgTransparent());

    return (
        <div className="space-y-6">
            <PageHeader icon={PaintBrush} title="Appearance" />

            {/* Theme — segmented control inside a card, matching the
                same rounded-xl + border + bg-card vocabulary the rest
                of the app uses for grouped settings. */}
            <section className="space-y-5 rounded-xl border border-border/50 bg-card p-5">
                <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold">Theme</h2>
                    <p className="text-xs text-muted-foreground">
                        Switch between light, dark, or follow your operating system.
                    </p>
                </div>

                <div
                    role="radiogroup"
                    aria-label="Theme"
                    className="inline-flex w-full max-w-md gap-1 rounded-lg border border-border bg-muted/40 p-1"
                >
                    {THEME_OPTIONS.map(opt => {
                        const active = theme === opt.value;
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                onClick={() => { setTheme(opt.value); }}
                                className={cn(
                                    "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                                    active
                                        ? "bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-border/60"
                                        : "text-muted-foreground hover:bg-background/40 hover:text-foreground",
                                )}
                            >
                                <Icon icon={opt.icon} className="size-4"/>
                                {opt.label}
                            </button>
                        );
                    })}
                </div>
            </section>

            {/* Messages — layout preferences for the chat timeline. */}
            <section className="space-y-5 rounded-xl border border-border/50 bg-card p-5">
                <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold">Messages</h2>
                    <p className="text-xs text-muted-foreground">
                        Choose how messages are laid out in chats.
                    </p>
                </div>

                <div className="flex items-center gap-4 border-t border-border/40 pt-4">
                    <div className="min-w-0 flex-1 space-y-0.5">
                        <label htmlFor="bubble-mode" className="block text-sm font-medium">
                            Bubble mode
                        </label>
                        <p className="text-xs text-muted-foreground">
                            Show messages as chat bubbles (iMessage / Telegram style). Turn off
                            for the classic avatar-and-name layout.
                        </p>
                    </div>
                    <Switch
                        id="bubble-mode"
                        checked={bubbleMode}
                        onCheckedChange={(next: boolean) => { setBubbleMode(next); }}
                    />
                </div>
            </section>

            {isDesktop && (
                <section className="space-y-5 rounded-xl border border-border/50 bg-card p-5">
                    <div className="space-y-0.5">
                        <h2 className="text-sm font-semibold">Desktop window</h2>
                        <p className="text-xs text-muted-foreground">
                            Tweak how the Clawbits window blends with your desktop.
                        </p>
                    </div>

                    <div className="flex items-center gap-4 border-t border-border/40 pt-4">
                        <div className="min-w-0 flex-1 space-y-0.5">
                            <label htmlFor="bg-transparent" className="block text-sm font-medium">
                                Background transparency
                            </label>
                            <p className="text-xs text-muted-foreground">
                                Lets the macOS desktop wallpaper show through the sidebar and main content.
                            </p>
                        </div>
                        <Switch
                            id="bg-transparent"
                            checked={bgTransparent}
                            onCheckedChange={(next: boolean) => {
                                setBgTransparent(next);
                                setAppBgTransparent(next);
                            }}
                        />
                    </div>
                </section>
            )}
        </div>
    );
}

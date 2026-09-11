import { useState } from "react";
import { PaintBrush01Icon as PaintBrush } from "@hugeicons/core-free-icons";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/PageHeader";
import { SettingsPage, SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { useTheme, type Theme } from "@/hooks/useTheme";
import { useBubbleMode, setBubbleMode } from "@/hooks/useBubbleMode";
import { isDesktop, getStoredAppBgTransparent, setAppBgTransparent } from "@/lib/desktop";

const THEMES: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };

export default function SettingsAppearancePage() {
    const { theme, setTheme } = useTheme();
    const bubbleMode = useBubbleMode();
    const [bgTransparent, setBgTransparent] = useState<boolean>(() => getStoredAppBgTransparent());

    return (
        <div>
            <PageHeader icon={PaintBrush} title="Appearance" />

            <SettingsPage>
                <SettingsSection label="Display">
                    <SettingsRow
                        title="Theme"
                        description="Light, dark, or match your system"
                        control={
                            <Select
                                value={theme}
                                items={THEMES}
                                onValueChange={(next) => { if (next) setTheme(next); }}
                            >
                                <SelectTrigger size="sm" aria-label="Theme">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {Object.entries(THEMES).map(([value, label]) => (
                                        <SelectItem key={value} value={value}>{label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        }
                    />
                    <SettingsRow
                        title="Message bubbles"
                        description="Chats as bubbles instead of the classic layout"
                        htmlFor="bubble-mode"
                        control={
                            <Switch
                                id="bubble-mode"
                                checked={bubbleMode}
                                onCheckedChange={(next: boolean) => { setBubbleMode(next); }}
                            />
                        }
                    />
                </SettingsSection>

                {isDesktop && (
                    <SettingsSection label="Desktop window">
                        <SettingsRow
                            title="Background transparency"
                            description="Let the wallpaper show through the window"
                            htmlFor="bg-transparent"
                            control={
                                <Switch
                                    id="bg-transparent"
                                    checked={bgTransparent}
                                    onCheckedChange={(next: boolean) => {
                                        setBgTransparent(next);
                                        setAppBgTransparent(next);
                                    }}
                                />
                            }
                        />
                    </SettingsSection>
                )}
            </SettingsPage>
        </div>
    );
}

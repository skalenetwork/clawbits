import { useState } from "react";
import { PaintBrush01Icon as PaintBrush } from "@hugeicons/core-free-icons";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/PageHeader";
import { SettingsPage, SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { useTheme, type Theme } from "@/hooks/useTheme";
import { isDesktop, getStoredTranslucency, setTranslucency } from "@/lib/desktop";
import { isMac } from "@/lib/shortcuts/platform";

const THEMES: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };

export default function SettingsAppearancePage() {
    const { theme, setTheme } = useTheme();
    const [translucent, setTranslucent] = useState(getStoredTranslucency);

    return (
        <SettingsPage>
            <PageHeader icon={PaintBrush} title="Appearance" />

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
            </SettingsSection>

            {isDesktop && isMac && (
                <SettingsSection label="Desktop window">
                    <SettingsRow
                        title="Sidebar transparency"
                        description="Let the wallpaper show through the sidebars"
                        htmlFor="sidebar-translucency"
                        control={
                            <Switch
                                id="sidebar-translucency"
                                checked={translucent}
                                onCheckedChange={(next) => {
                                    setTranslucent(next);
                                    setTranslucency(next);
                                }}
                            />
                        }
                    />
                </SettingsSection>
            )}
        </SettingsPage>
    );
}

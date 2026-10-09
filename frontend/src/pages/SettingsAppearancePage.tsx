import { useState } from "react";
import { PaintBrush01Icon as PaintBrush } from "@hugeicons/core-free-icons";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/PageHeader";
import { SettingsPage, SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { DELAY_RANGE, dictationSupported, getDictationPrefs, setDictationPrefs, type DictationPrefs } from "@/hooks/useDictation";
import { useTheme, type Theme } from "@/hooks/useTheme";
import { isMacDesktop, getStoredTranslucency, setTranslucency } from "@/lib/desktop";
import { setPieceSet, usePieceSet, type PieceSet } from "@/lib/pieceSet";

const THEMES: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };
const PIECE_SETS: Record<PieceSet, string> = { sea: "Sea", classic: "Classic" };
const SECONDS = new Intl.NumberFormat("en", { style: "unit", unit: "second", unitDisplay: "long" });

export default function SettingsAppearancePage() {
    const { theme, setTheme } = useTheme();
    const pieceSet = usePieceSet();
    const [translucent, setTranslucent] = useState(getStoredTranslucency);
    const [dictation, setDictation] = useState(getDictationPrefs);
    const updateDictation = (change: Partial<DictationPrefs>) => {
        const next = { ...dictation, ...change };
        setDictation(next);
        setDictationPrefs(next);
    };

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
                <SettingsRow
                    title="Chess pieces"
                    description="Sea creatures or classic shapes, on this device"
                    control={
                        <Select
                            value={pieceSet}
                            items={PIECE_SETS}
                            onValueChange={(next) => { if (next) setPieceSet(next); }}
                        >
                            <SelectTrigger size="sm" aria-label="Chess pieces">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {Object.entries(PIECE_SETS).map(([value, label]) => (
                                    <SelectItem key={value} value={value}>{label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    }
                />
            </SettingsSection>

            {isMacDesktop && (
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

            {dictationSupported && (
                <SettingsSection label="Dictation">
                    <SettingsRow
                        title="Send when I stop talking"
                        description="Dictated messages send themselves once you pause"
                        htmlFor="dictation-auto-send"
                        control={
                            <Switch
                                id="dictation-auto-send"
                                checked={dictation.autoSend}
                                onCheckedChange={(autoSend) => { updateDictation({ autoSend }); }}
                            />
                        }
                    />
                    {dictation.autoSend && (
                        <SettingsRow
                            title="Pause before sending"
                            description={SECONDS.format(dictation.delayMs / 1000)}
                            control={
                                <Slider
                                    {...DELAY_RANGE}
                                    aria-label="Pause before sending"
                                    className="w-40"
                                    value={dictation.delayMs}
                                    onValueChange={(delayMs) => { updateDictation({ delayMs }); }}
                                />
                            }
                        />
                    )}
                </SettingsSection>
            )}
        </SettingsPage>
    );
}

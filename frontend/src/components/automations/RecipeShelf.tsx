import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { AutomationWell } from "@/components/automations/AutomationWell";
import { SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { Button } from "@/components/ui/button";
import type { Automation } from "@/lib/api";
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "@/lib/automations";
import { describeSchedule } from "@/lib/schedule";

export function RecipeShelf({
  automations,
  base,
  selectedId,
  onPick,
}: {
  automations: Automation[];
  base: string;
  selectedId: string | null;
  onPick: (template: AutomationTemplate) => void;
}) {
  const existing = new Set(automations.map((a) => (a.name ?? "").toLowerCase()));
  const available = AUTOMATION_TEMPLATES.filter((t) => !existing.has(t.defaultName.toLowerCase()));
  const recipes = [...available.filter((t) => t.pinned), ...available.filter((t) => !t.pinned)].slice(0, 3);
  if (recipes.length === 0) return null;

  return (
    <SettingsSection label="Suggested" footer="Suggestions open prefilled. Nothing runs until you automate it.">
      {recipes.map((t) => (
        <SettingsRow
          key={t.id}
          to={`${base}?recipe=${t.id}`}
          replace
          selected={t.id === selectedId}
          leading={<AutomationWell accent={t.accent ?? null} icon={t.icon} />}
          title={t.label}
          description={describeSchedule(t.defaultSchedule)}
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onPick(t);
              }}
            >
              <Icon icon={PlusSignIcon} />
              Add
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}

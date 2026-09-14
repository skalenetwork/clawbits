import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { AutomationWell } from "@/components/automations/AutomationWell";
import { PromptSection } from "@/components/automations/PromptSection";
import { Button } from "@/components/ui/button";
import type { AutomationTemplate } from "@/lib/automations";
import { describeSchedule } from "@/lib/schedule";

export function RecipePreview({ template: t, onAdd }: { template: AutomationTemplate; onAdd: () => void }) {
  return (
    <div className="flex flex-col gap-[18px] px-2.5 pb-4">
      <div className="flex items-center gap-3">
        <AutomationWell accent={t.accent ?? null} icon={t.icon} large />
        <div className="min-w-0 leading-snug">
          <h3 className="truncate text-base font-semibold tracking-tight">{t.label}</h3>
          <p className="truncate text-[13px] text-muted-foreground">{describeSchedule(t.defaultSchedule)}</p>
        </div>
      </div>
      <p className="border-y border-foreground/8 py-2.5 text-[13px] leading-normal text-muted-foreground">
        {t.description}
      </p>
      <PromptSection prompt={t.prompt} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onAdd}>
          <Icon icon={PlusSignIcon} />
          Add
        </Button>
      </div>
    </div>
  );
}

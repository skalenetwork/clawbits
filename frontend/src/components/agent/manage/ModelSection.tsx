import { useState } from "react";
import { ModelPicker } from "@/components/composer/ModelPicker";
import { SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { useAgentModels } from "@/hooks/useAgentModels";

export function ModelSection({ orgId, agentId }: { orgId: string; agentId: string }) {
  const [open, setOpen] = useState(false);
  const models = useAgentModels(orgId, agentId).data;

  if (!models?.models) return null;

  return (
    <SettingsSection label="Model">
      <SettingsRow
        title="Default model and effort"
        control={
          <ModelPicker
            orgId={orgId}
            agentId={agentId}
            channelId={null}
            value={models.default}
            variant="select"
            align="end"
            open={open}
            onOpenChange={setOpen}
          />
        }
      />
    </SettingsSection>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LockIcon as LockShieldIcon } from "@hugeicons/core-free-icons";

import { PageHeader } from "@/components/PageHeader";
import { SettingsPage, SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { Switch } from "@/components/ui/switch";
import {
  getPrivacySettings,
  updatePrivacySettings,
  type PrivacySettings,
} from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";

const SECTIONS: {
  label: string;
  footer?: string;
  rows: { key: keyof PrivacySettings; title: string; description: string }[];
}[] = [
  {
    label: "Presence",
    rows: [
      {
        key: "last_seen_visible",
        title: "Show last seen time",
        description: "When off, others see “Last seen recently”",
      },
      {
        key: "online_status_visible",
        title: "Show online status",
        description: "When off, you always appear offline",
      },
    ],
  },
  {
    label: "Messaging",
    footer: "Changes apply to new activity.",
    rows: [
      {
        key: "read_receipts_enabled",
        title: "Send read receipts",
        description: "When off, others won't see that you read their messages",
      },
      {
        key: "typing_indicators_enabled",
        title: "Send typing indicators",
        description: "When off, others won't see you typing",
      },
    ],
  },
];

export default function SettingsPrivacyPage() {
  const qc = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: queryKeys.privacySettings,
    queryFn: getPrivacySettings,
  });

  const mutation = useMutation({
    mutationFn: (patch: Partial<PrivacySettings>) => updatePrivacySettings(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: queryKeys.privacySettings });
      const previous = qc.getQueryData<PrivacySettings>(queryKeys.privacySettings);
      if (previous) {
        qc.setQueryData<PrivacySettings>(queryKeys.privacySettings, {
          ...previous,
          ...patch,
        });
      }
      return { previous };
    },
    onError: (err, _patch, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(queryKeys.privacySettings, ctx.previous);
      }
      toast.error(errMsg(err, "Couldn't update privacy settings"));
    },
    onSuccess: (server) => {
      qc.setQueryData(queryKeys.privacySettings, server);
    },
  });

  const settings = settingsQuery.data;

  return (
    <SettingsPage>
      <PageHeader icon={LockShieldIcon} title="Privacy" />
      {settingsQuery.isError ? (
        <SettingsSection>
          <SettingsRow
            title="Couldn't load privacy settings"
            error={errMsg(settingsQuery.error)}
          />
        </SettingsSection>
      ) : (
        SECTIONS.map(section => (
          <SettingsSection key={section.label} label={section.label} footer={section.footer}>
            {section.rows.map(row => (
              <SettingsRow
                key={row.key}
                title={row.title}
                description={row.description}
                htmlFor={`privacy-${row.key}`}
                control={
                  <Switch
                    id={`privacy-${row.key}`}
                    checked={settings?.[row.key] ?? true}
                    disabled={!settings || mutation.isPending}
                    onCheckedChange={(next) => {
                      mutation.mutate({ [row.key]: next });
                    }}
                  />
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPage>
  );
}

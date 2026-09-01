import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LockIcon as LockShieldIcon } from "@hugeicons/core-free-icons";

import { PageHeader } from "@/components/PageHeader";
import { Switch } from "@/components/ui/switch";
import {
  getPrivacySettings,
  updatePrivacySettings,
  type PrivacySettings,
} from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";

interface PrivacyToggleRow {
  /** Flag name on :class:`PrivacySettings`. */
  key: keyof PrivacySettings;
  label: string;
  /** Short caption under the label explaining what flipping it does. */
  description: string;
}

const SECTIONS: { heading: string; rows: PrivacyToggleRow[] }[] = [
  {
    heading: "Presence",
    rows: [
      {
        key: "last_seen_visible",
        label: "Show my last seen time",
        description:
          "When off, others see \"Last seen recently\" instead of the exact time you were last online.",
      },
      {
        key: "online_status_visible",
        label: "Show my online status",
        description:
          "When off, your presence dot always appears offline to other members of channels and DMs.",
      },
    ],
  },
  {
    heading: "Messaging",
    rows: [
      {
        key: "read_receipts_enabled",
        label: "Send read receipts",
        description:
          "When off, others won't see \"Read\" under their outgoing messages once you've caught up. Your own unread badge still works.",
      },
      {
        key: "typing_indicators_enabled",
        label: "Send typing indicators",
        description:
          "When off, others won't see \"…is typing\" while you're composing a message.",
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
  const loading = settingsQuery.isLoading;

  return (
    <div className="space-y-6">
      <PageHeader icon={LockShieldIcon} title="Privacy" />

      <p className="text-sm text-muted-foreground">
        Choose which signals other members of your organization can see
        about you. Changes take effect immediately for new events;
        already-rendered content updates when peers refresh.
      </p>

      {SECTIONS.map(section => (
        <section
          key={section.heading}
          className="space-y-5 rounded-xl border border-border/50 bg-card p-5"
        >
          <div className="space-y-0.5">
            <h2 className="text-sm font-semibold">{section.heading}</h2>
          </div>

          <div className="space-y-4">
            {section.rows.map((row, idx) => {
              const checked = settings ? settings[row.key] : true;
              const inputId = `privacy-${row.key}`;
              return (
                <div
                  key={row.key}
                  className={
                    "flex items-center gap-4" +
                    (idx > 0 ? " border-t border-border/40 pt-4" : "")
                  }
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <label
                      htmlFor={inputId}
                      className="block text-sm font-medium"
                    >
                      {row.label}
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {row.description}
                    </p>
                  </div>
                  <Switch
                    id={inputId}
                    checked={checked}
                    disabled={loading || mutation.isPending}
                    onCheckedChange={(next: boolean) => {
                      mutation.mutate({ [row.key]: next });
                    }}
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

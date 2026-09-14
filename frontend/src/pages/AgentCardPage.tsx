import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { AccessCard } from "@/components/agent/AccessCard";
import { useAgentTab } from "@/components/agent/agentTabContext";
import { SquircleDefs } from "@/components/home/tiles";
import { SettingsRow, SettingsSection, SettingsStatus } from "@/components/settings/Settings";
import { agentDisplay } from "@/lib/agentDisplay";
import { MARK_COPY, formatMarkDate, tidemarkState } from "@/lib/tidemarks";

export default function AgentCardPage() {
  const { profile } = useAgentTab();
  const [open, setOpen] = useState(false);
  const tide = tidemarkState(profile.tidemarks);
  const name = agentDisplay(profile);
  const since = tide.earnedAt ?? profile.creation_time;

  return (
    <>
      <SquircleDefs />
      <AccessCard profile={profile} tide={tide} />
      <SettingsSection label="Rarity">
        <SettingsRow
          title={tide.label}
          description={since && `${tide.earnedAt ? "Earned" : "Joined"} ${formatMarkDate(since)}`}
          expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          control={
            <span className="disclosure-chevron inline-flex text-muted-foreground" data-open={open}>
              <ChevronDown className="size-4" />
            </span>
          }
        />
        {open &&
          profile.tidemarks.kinds.map((kind) => {
            const mark = profile.tidemarks.marks.find((m) => m.kind === kind);
            return (
              <SettingsRow
                key={kind}
                title={MARK_COPY[kind].title}
                description={mark?.detail ?? MARK_COPY[kind].howTo(name, profile.email_address)}
                control={
                  mark?.earned_at ? (
                    <SettingsStatus tone="ok">{formatMarkDate(mark.earned_at)}</SettingsStatus>
                  ) : (
                    <SettingsStatus tone="idle">Not yet</SettingsStatus>
                  )
                }
              />
            );
          })}
      </SettingsSection>
    </>
  );
}

import { Fragment, useState } from "react";
import { AccessCard } from "@/components/agent/AccessCard";
import { useAgentTab } from "@/components/agent/agentTabContext";
import { SquircleDefs } from "@/components/home/tiles";
import { SettingsRow, SettingsSection, SettingsStatus } from "@/components/settings/Settings";
import { agentDisplay } from "@/lib/agentDisplay";
import type { TidemarkBandId } from "@/lib/api";
import { BAND_LABEL, bandCount, MARK_COPY, formatMarkDate, tidemarkState } from "@/lib/tidemarks";

export default function AgentCardPage() {
  const { profile } = useAgentTab();
  const [open, setOpen] = useState<TidemarkBandId | null>(null);
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
        />
      </SettingsSection>
      <SettingsSection label="Achievements">
        {tide.bands.map((band) => (
          <Fragment key={band.id}>
            <SettingsRow
              title={BAND_LABEL[band.id]}
              description={bandCount(band)}
              expanded={open === band.id}
              onClick={() => {
                setOpen(open === band.id ? null : band.id);
              }}
            />
            {open === band.id &&
              band.marks.map(({ kind, mark }) => (
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
              ))}
          </Fragment>
        ))}
      </SettingsSection>
    </>
  );
}

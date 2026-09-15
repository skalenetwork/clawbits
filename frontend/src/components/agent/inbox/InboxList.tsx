import type { ReactNode } from "react";
import { Attachment01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { SettingsRow, SettingsSection } from "@/components/settings/Settings";
import type { EmailSummary } from "@/lib/api";
import { formatRelativeShort } from "@/lib/formatting";
import { cn } from "@/lib/utils";
import { dayBucket, senderName, type DayBucket } from "./emailDisplay";
import { SenderMonogram } from "./SenderMonogram";

export function InboxList({
  emails,
  now,
  unread,
  selectedUid,
  footer,
  onOpen,
}: {
  emails: EmailSummary[];
  now: number;
  unread: number;
  selectedUid: number | undefined;
  footer: ReactNode;
  onOpen: (uid: number) => void;
}) {
  const groups: { bucket: DayBucket; emails: EmailSummary[] }[] = [];
  for (const email of emails) {
    const bucket = dayBucket(email.date, now);
    const last = groups.at(-1);
    if (last?.bucket === bucket) last.emails.push(email);
    else groups.push({ bucket, emails: [email] });
  }

  return (
    <>
      {groups.map(({ bucket, emails: group }, i) => (
        <SettingsSection
          key={i}
          label={bucket}
          aside={i === 0 && unread > 0 ? `${String(unread)} unread` : undefined}
          footer={i === groups.length - 1 ? footer : undefined}
        >
          {group.map((email) => (
            <SettingsRow
              key={email.uid}
              leading={<SenderMonogram from={email.from_addr} />}
              selected={email.uid === selectedUid}
              title={
                <span className={cn("block truncate", email.is_read && "font-normal text-muted-foreground")}>
                  {senderName(email.from_addr)}
                </span>
              }
              description={<span className="block truncate">{email.subject || "(no subject)"}</span>}
              control={
                <>
                  {!email.is_read && (
                    <span role="img" aria-label="Unread" className="size-[7px] rounded-full bg-(--mention)" />
                  )}
                  {email.has_attachments && (
                    <Icon icon={Attachment01Icon} className="size-3.5 text-muted-foreground" />
                  )}
                  <span className="min-w-[26px] text-right text-[13px] text-muted-foreground tabular-nums">
                    {formatRelativeShort(email.date)}
                  </span>
                </>
              }
              onClick={() => {
                onOpen(email.uid);
              }}
            />
          ))}
        </SettingsSection>
      ))}
    </>
  );
}

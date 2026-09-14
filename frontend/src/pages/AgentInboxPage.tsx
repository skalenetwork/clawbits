import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Copy01Icon, Mail01Icon, MailSend01Icon } from "@hugeicons/core-free-icons";
import { Mail, MailOpen, Trash2 } from "lucide-react";
import { Icon } from "@/components/Icon";
import { useAgentTab } from "@/components/agent/agentTabContext";
import { InboxList } from "@/components/agent/inbox/InboxList";
import { MessageView } from "@/components/agent/inbox/MessageView";
import {
  MAX_LIMIT,
  PAGE_SIZE,
  useAgentInboxCount,
  useAgentInboxList,
  useDeleteEmail,
  useMarkRead,
  writeReadStateToCache,
} from "@/components/agent/inbox/useInbox";
import { SettingsRow, SettingsRowSkeleton, SettingsSection } from "@/components/settings/Settings";
import { PANEL_ICON_BUTTON } from "@/components/sidebars/rightPanelContext";
import { SidePanel } from "@/components/sidebars/SidePanel";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/useNow";
import { agentDisplay } from "@/lib/agentDisplay";
import { confirm } from "@/lib/confirm";
import { errMsg, toast } from "@/lib/toast";

export default function AgentInboxPage() {
  const { orgId, agentId, profile } = useAgentTab();
  const { uid } = useParams<{ uid?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const now = useNow();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const inboxQuery = useAgentInboxList(orgId, agentId, limit);
  const countQuery = useAgentInboxCount(orgId, agentId);
  const markRead = useMarkRead(orgId, agentId);

  const base = `/agents/${encodeURIComponent(agentId)}/inbox`;
  const emails = inboxQuery.data?.emails ?? [];
  const index = emails.findIndex((e) => String(e.uid) === uid);
  const open = emails[index];
  const name = agentDisplay(profile);
  const address = profile.email_address;

  const deleteEmail = useDeleteEmail(orgId, agentId, (deleted) => {
    if (deleted !== open?.uid) return;
    const next = emails[index + 1] ?? emails[index - 1];
    void navigate(next ? `${base}/${String(next.uid)}` : base, { replace: true });
  });

  const openMessage = (target: number) => {
    writeReadStateToCache(queryClient, orgId, agentId, target, true);
    void navigate(`${base}/${String(target)}`, { replace: true });
  };

  const remove = async (target: number) => {
    const ok = await confirm({
      title: "Delete this message?",
      description: "This permanently removes it from the agent's mailbox. This can't be undone.",
      confirmLabel: "Delete",
    });
    if (ok) deleteEmail.mutate(target);
  };

  const readLabel = open?.is_read ? "Mark as unread" : "Mark as read";
  const hasMore = (inboxQuery.data?.total ?? 0) > emails.length;
  const footer = !hasMore ? undefined : emails.length >= MAX_LIMIT ? (
    `Showing the newest ${String(MAX_LIMIT)} messages.`
  ) : (
    <button
      type="button"
      disabled={inboxQuery.isPlaceholderData}
      onClick={() => {
        setLimit((n) => Math.min(n + PAGE_SIZE, MAX_LIMIT));
      }}
      className="font-medium transition-colors hover:text-foreground disabled:opacity-50"
    >
      {inboxQuery.isPlaceholderData ? "Loading…" : "Load more"}
    </button>
  );

  if (inboxQuery.data && uid != null && !open) return <Navigate to={base} replace />;

  return (
    <>
      {address && (
        <SettingsSection label="Address">
          <SettingsRow
            leading={
              <span className="grid size-8 place-items-center rounded-[9px] bg-foreground/5 text-muted-foreground">
                <Icon icon={Mail01Icon} className="size-4" />
              </span>
            }
            title={address}
            description={`Anyone can write to ${name} at this address`}
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(address);
                  toast.success("Address copied");
                }}
              >
                <Icon icon={Copy01Icon} />
                Copy
              </Button>
            }
          />
        </SettingsSection>
      )}

      {emails.length > 0 ? (
        <InboxList
          emails={emails}
          now={now}
          unread={countQuery.data?.unread ?? 0}
          selectedUid={open?.uid}
          footer={footer}
          onOpen={openMessage}
        />
      ) : (
        <SettingsSection>
          {inboxQuery.data ? (
            <SettingsRow
              title="No mail yet"
              description={`Messages ${name} receives show up here`}
              control={
                address ? (
                  <Button size="sm" nativeButton={false} render={<a href={`mailto:${address}`} />}>
                    <Icon icon={MailSend01Icon} />
                    Send {name} their first email
                  </Button>
                ) : null
              }
            />
          ) : inboxQuery.isError ? (
            <SettingsRow title="Couldn't load the inbox" error={errMsg(inboxQuery.error)} />
          ) : (
            [0, 1, 2].map((i) => <SettingsRowSkeleton key={i} />)
          )}
        </SettingsSection>
      )}

      <SidePanel
        open={open != null}
        title="Message"
        onClose={() => {
          void navigate(base, { replace: true });
        }}
        actions={
          open && (
            <>
              <button
                type="button"
                aria-label={readLabel}
                title={readLabel}
                className={PANEL_ICON_BUTTON}
                onClick={() => {
                  markRead.mutate({ uid: open.uid, read: !open.is_read });
                }}
              >
                {open.is_read ? <Mail className="size-4" /> : <MailOpen className="size-4" />}
              </button>
              <button
                type="button"
                aria-label="Delete"
                title="Delete"
                disabled={deleteEmail.isPending}
                className={PANEL_ICON_BUTTON}
                onClick={() => {
                  void remove(open.uid);
                }}
              >
                <Trash2 className="size-4" />
              </button>
            </>
          )
        }
      >
        {open && <MessageView key={open.uid} orgId={orgId} agentId={agentId} uid={open.uid} />}
      </SidePanel>
    </>
  );
}

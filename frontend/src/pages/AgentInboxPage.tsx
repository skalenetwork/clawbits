/**
 * AgentInboxPage — an agent's mailbox as a real mail client.
 *
 * Desktop (lg+): a full-height split view — masthead strip, then a fixed
 * message column beside a persistent reading pane. The open message lives in
 * the URL (`/agents/:id/inbox/:uid?` — one optional-segment route, so
 * selection changes never remount the page). Mobile: the same routes render
 * as list ⇢ full-screen message with a row→page hero morph.
 *
 * Operator-only (the inbox endpoints reject anyone else); the profile comes
 * from AgentShell's outlet context. Legacy `?uid=N` links redirect to the
 * routed form.
 */
import { useEffect, useState } from "react";
import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { agentBreadcrumbs } from "@/components/agent/agentBreadcrumbs";
import type { AgentOutletContext } from "@/components/agent/AgentShell";
import { InboxList } from "@/components/agent/inbox/InboxList";
import { MessageView } from "@/components/agent/inbox/MessageView";
import { MessagePaneEmpty } from "@/components/agent/inbox/MessagePaneEmpty";
import {
  PAGE_SIZE,
  MAX_LIMIT,
  POLL_MS,
  useAgentInboxList,
  useDeleteEmail,
  useMarkRead,
  writeReadStateToCache,
} from "@/components/agent/inbox/useInbox";
import { senderName } from "@/components/agent/inbox/emailDisplay";
import { InboxEmptyHero } from "@/components/agent/inbox/InboxEmptyHero";
import { getAgentInboxCount, type EmailSummary } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { confirm } from "@/lib/confirm";
import { agentDisplay } from "@/lib/agentDisplay";
import { useIsMobile } from "@/hooks/use-mobile";
import { useNow } from "@/hooks/useNow";
import { useShortcut } from "@/lib/shortcuts";
import {
  INBOX_MESSAGE_VT_NAME,
  morphHeroNavigation,
  waitForElement,
} from "@/lib/viewTransition";

/** Mobile list scroll positions, per agent, surviving list ⇄ message trips. */
const listScrollStash = new Map<string, number>();

function truncateLabel(s: string, max = 32): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Desktop-only key bindings: j/k walk the list (Outlook reading-pane model),
 *  Esc closes the pane, ⌫ deletes. Registered via the central provider so
 *  they appear in the hold-⌘ hint overlay and unregister on route leave. */
function InboxShortcuts({
  uid,
  onMove,
  onClose,
  onDelete,
}: {
  uid: number | null;
  onMove: (dir: 1 | -1) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  // Base UI keeps closed dialogs mounted (e.g. the ConfirmHost shell), so
  // presence alone is a false positive — ``data-open`` marks the live ones.
  const noDialogOpen = () => !document.querySelector('[role="dialog"][data-open]');
  useShortcut({
    id: "inbox-next",
    keys: "j",
    run: () => {
      onMove(1);
    },
    when: ({ inEditable }) => !inEditable && noDialogOpen(),
    hint: { label: "J", group: "Inbox", description: "Next message" },
  });
  useShortcut({
    id: "inbox-prev",
    keys: "k",
    run: () => {
      onMove(-1);
    },
    when: ({ inEditable }) => !inEditable && noDialogOpen(),
    hint: { label: "K", group: "Inbox", description: "Previous message" },
  });
  useShortcut({
    id: "inbox-close",
    keys: "Escape",
    run: onClose,
    when: ({ inEditable }) => !inEditable && uid != null && noDialogOpen(),
  });
  useShortcut({
    id: "inbox-delete",
    keys: "Backspace",
    run: onDelete,
    when: ({ inEditable }) => !inEditable && uid != null && noDialogOpen(),
    hint: { label: "⌫", group: "Inbox", description: "Delete message" },
  });
  return null;
}

export default function AgentInboxPage() {
  const { orgId, agentId, profile, isLoading } = useOutletContext<AgentOutletContext>();
  const { uid: uidParam } = useParams<{ uid?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const now = useNow();

  const parsedUid = uidParam != null ? Number(uidParam) : NaN;
  const uid = Number.isFinite(parsedUid) ? parsedUid : null;
  const base = `/agents/${encodeURIComponent(agentId ?? "")}/inbox`;

  const [limit, setLimit] = useState(PAGE_SIZE);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const canQuery = Boolean(profile?.is_operator && agentId);
  const inboxQuery = useAgentInboxList(canQuery ? orgId : "", agentId ?? "", {
    limit,
    unreadOnly,
  });
  // The count endpoint feeds the masthead + filter chips with whole-mailbox
  // numbers, independent of the active filter. Shares its key (and thus its
  // cache) with the sidebar unread badge.
  const countQuery = useQuery({
    queryKey: queryKeys.agentInbox.count(orgId, agentId ?? ""),
    queryFn: () => getAgentInboxCount(orgId, agentId ?? ""),
    enabled: canQuery && Boolean(orgId),
    refetchInterval: POLL_MS,
  });

  const emails: EmailSummary[] = inboxQuery.data?.emails ?? [];
  const agentName = profile ? agentDisplay(profile) : (agentId ?? "Agent");

  const markRead = useMarkRead(orgId, agentId ?? "");
  const deleteEmail = useDeleteEmail(orgId, agentId ?? "", (deletedUid) => {
    if (uid !== deletedUid) return;
    const idx = emails.findIndex((e) => e.uid === deletedUid);
    const next = emails[idx + 1] ?? emails[idx - 1] ?? null;
    if (isMobile || !next) void navigate(base, { replace: true });
    else void navigate(`${base}/${String(next.uid)}`, { replace: true });
  });

  const openMessage = (openUid: number, sourceEl: HTMLElement | null) => {
    // Instant de-bold: the detail GET will mark it \Seen server-side anyway,
    // so the cache write is truthful, just early.
    writeReadStateToCache(queryClient, orgId, agentId ?? "", openUid, true);
    const go = () => {
      void navigate(`${base}/${String(openUid)}`);
    };
    if (isMobile) {
      const main = document.querySelector("main");
      if (agentId && main) listScrollStash.set(agentId, main.scrollTop);
      morphHeroNavigation({
        name: INBOX_MESSAGE_VT_NAME,
        navigate: go,
        waitForTarget: () => waitForElement(".vt-inbox-message"),
        nameSource: sourceEl,
      });
    } else {
      go();
    }
  };

  const closeMessage = () => {
    void navigate(base);
  };

  const requestDelete = (deleteUid: number) => {
    void (async () => {
      const ok = await confirm({
        title: "Delete this message?",
        description: "This permanently removes it from the agent's mailbox. This can't be undone.",
        confirmLabel: "Delete",
      });
      if (ok) deleteEmail.mutate(deleteUid);
    })();
  };

  const toggleRead = (targetUid: number, read: boolean) => {
    markRead.mutate({ uid: targetUid, read });
  };

  const moveSelection = (dir: 1 | -1) => {
    if (emails.length === 0) return;
    const idx = uid == null ? -1 : emails.findIndex((e) => e.uid === uid);
    const next =
      idx === -1 ? (dir === 1 ? emails[0] : emails[emails.length - 1]) : emails[idx + dir];
    if (next) openMessage(next.uid, null);
  };

  // Restore the stashed mobile list scroll position on the way back. The
  // rows may paint a frame (or a refetch) later than this effect, and a
  // too-early scrollTo clamps to 0 — so retry until the scroller is tall
  // enough to hold the stashed offset.
  const emailCount = emails.length;
  useEffect(() => {
    if (!isMobile || uid != null || !agentId) return;
    const stash = listScrollStash.get(agentId);
    if (stash == null) return;
    const main = document.querySelector("main");
    if (!main) return;
    let tries = 0;
    let timer: number | null = null;
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      tries += 1;
      if (main.scrollHeight - main.clientHeight >= stash - 1) {
        main.scrollTo({ top: stash });
        listScrollStash.delete(agentId);
        return;
      }
      // Not tall enough yet (rows still loading) — retry on a timer (rAF can
      // be throttled in background tabs); the stash survives exhaustion so
      // the emailCount dep re-runs this when the data lands.
      if (tries <= 12) timer = window.setTimeout(apply, 80);
    };
    apply();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [isMobile, uid, agentId, emailCount]);

  // The mobile message page starts at the top.
  useEffect(() => {
    if (isMobile && uid != null) document.querySelector("main")?.scrollTo({ top: 0 });
  }, [isMobile, uid]);

  // ── Guards & redirects (after all hooks) ─────────────────────────────────
  const openEmail = uid != null ? emails.find((e) => e.uid === uid) : undefined;
  const detailLabel = openEmail
    ? openEmail.subject.trim() !== ""
      ? openEmail.subject
      : senderName(openEmail.from_addr)
    : "Message";
  const crumbs = agentBreadcrumbs(agentId, profile, "inbox", {
    detail: uid != null ? { label: truncateLabel(detailLabel) } : undefined,
  });

  const emailAddress = profile?.email_address ?? null;

  if (!profile) {
    return (
      <div className="pb-16">
        <PageHeader breadcrumb={crumbs} />
        <div className="py-12 text-center text-sm text-muted-foreground">
          {isLoading ? "Loading…" : "Couldn't load this agent."}
        </div>
      </div>
    );
  }
  if (!profile.is_operator) {
    return (
      <div className="pb-16">
        <PageHeader breadcrumb={crumbs} />
        <div className="py-12 text-center text-sm text-muted-foreground">
          Only this agent&apos;s operator can view its inbox.
        </div>
      </div>
    );
  }

  const counts = countQuery.data;
  const mailboxEmpty =
    counts?.total === 0 && !inboxQuery.isLoading && emails.length === 0;

  const listProps = {
    emails,
    totalForView: inboxQuery.data?.total ?? 0,
    isLoading: inboxQuery.isLoading,
    isError: inboxQuery.isError,
    error: inboxQuery.error,
    isPlaceholder: inboxQuery.isPlaceholderData,
    unreadOnly,
    onUnreadOnlyChange: setUnreadOnly,
    allCount: counts?.total ?? inboxQuery.data?.total ?? 0,
    unreadCount: counts?.unread ?? inboxQuery.data?.unread_count ?? 0,
    selectedUid: uid,
    onOpen: openMessage,
    onToggleRead: toggleRead,
    onDelete: requestDelete,
    onLoadMore: () => {
      setLimit((n) => Math.min(n + PAGE_SIZE, MAX_LIMIT));
    },
    now,
  };

  // ── Mobile: list page ⇢ full-screen message page ──────────────────────────
  if (isMobile) {
    return (
      <div className="pb-4">
        <PageHeader breadcrumb={crumbs} />
        {uid != null ? (
          <MessageView
            key={uid}
            orgId={orgId}
            agentId={profile.agent_id}
            uid={uid}
            variant="page"
            onDelete={requestDelete}
            deletePending={deleteEmail.isPending}
          />
        ) : mailboxEmpty ? (
          <InboxEmptyHero agentName={agentName} emailAddress={emailAddress} />
        ) : (
          <InboxList {...listProps} />
        )}
      </div>
    );
  }

  // ── Desktop: masthead + split (list column | reading pane) ───────────────
  return (
    <div className="flex h-full min-h-0 flex-col pt-12">
      <PageHeader breadcrumb={crumbs} />
      <InboxShortcuts
        uid={uid}
        onMove={moveSelection}
        onClose={closeMessage}
        onDelete={() => {
          if (uid != null) requestDelete(uid);
        }}
      />
      {mailboxEmpty ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <InboxEmptyHero agentName={agentName} emailAddress={emailAddress} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            data-inbox-scroll
            className="w-72 shrink-0 overflow-y-auto border-r border-border/60"
          >
            <InboxList {...listProps} />
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {uid != null ? (
              <MessageView
                key={uid}
                orgId={orgId}
                agentId={profile.agent_id}
                uid={uid}
                variant="pane"
                onClose={closeMessage}
                onDelete={requestDelete}
                deletePending={deleteEmail.isPending}
              />
            ) : (
              <MessagePaneEmpty />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

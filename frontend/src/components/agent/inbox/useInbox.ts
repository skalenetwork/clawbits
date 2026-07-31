/**
 * Data hooks for the agent inbox. One place owns the query keys, the polling
 * cadence, and the optimistic read-state writes so the list, the masthead,
 * the reading pane, and the sidebar unread badge always agree.
 */
import { useCallback } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  deleteAgentEmail,
  getAgentEmail,
  getAgentInbox,
  setAgentEmailRead,
  type AgentInbox,
  type AgentInboxCount,
} from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";

export const PAGE_SIZE = 50;
/** Client-side ceiling matching the server clamp — the growing-limit window
 *  stops here and the list says so instead of silently truncating. */
export const MAX_LIMIT = 200;
// Auto-refresh cadence for the inbox + unread badge. React Query pauses this
// while the browser tab is hidden (refetchIntervalInBackground defaults false)
// and refetches immediately on window refocus.
export const POLL_MS = 30_000;

export function useAgentInboxList(
  orgId: string,
  agentId: string,
  opts: { limit: number; unreadOnly: boolean },
) {
  return useQuery({
    queryKey: queryKeys.agentInbox.list(orgId, agentId, opts.limit, 0, opts.unreadOnly),
    queryFn: () =>
      getAgentInbox(orgId, agentId, { limit: opts.limit, offset: 0, unreadOnly: opts.unreadOnly }),
    enabled: Boolean(orgId && agentId),
    refetchInterval: POLL_MS,
    placeholderData: keepPreviousData,
  });
}

export function useAgentEmail(orgId: string, agentId: string, uid: number) {
  return useQuery({
    queryKey: queryKeys.agentInbox.email(orgId, agentId, uid),
    queryFn: () => getAgentEmail(orgId, agentId, uid),
    enabled: Boolean(orgId && agentId),
  });
}

/** Refresh the list + the count badge without touching any open message
 *  (re-fetching an open message would re-mark it read in a loop). */
export function useInboxInvalidate(orgId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agentInbox.count(orgId, agentId) });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.agentInbox.listPrefix(orgId, agentId),
    });
  }, [queryClient, orgId, agentId]);
}

/**
 * Flip one message's read state across every cached list variant + the count
 * badge. Synchronous cache surgery — used for the instant de-bold on row open
 * (the detail GET marks ``\Seen`` server-side; no PATCH needed) and as the
 * optimistic step of the explicit mark-read mutation.
 */
export function writeReadStateToCache(
  queryClient: QueryClient,
  orgId: string,
  agentId: string,
  uid: number,
  read: boolean,
): void {
  queryClient.setQueriesData<AgentInbox>(
    { queryKey: queryKeys.agentInbox.listPrefix(orgId, agentId) },
    (old) => {
      if (!old) return old;
      const target = old.emails.find((e) => e.uid === uid);
      if (!target || target.is_read === read) return old;
      return {
        ...old,
        unread_count: Math.max(0, old.unread_count + (read ? -1 : 1)),
        emails: old.emails.map((e) => (e.uid === uid ? { ...e, is_read: read } : e)),
      };
    },
  );
  queryClient.setQueryData<AgentInboxCount>(
    queryKeys.agentInbox.count(orgId, agentId),
    (old) => (old ? { ...old, unread: Math.max(0, old.unread + (read ? -1 : 1)) } : old),
  );
}

/** Explicit mark read/unread (the PATCH endpoint), applied optimistically. */
export function useMarkRead(orgId: string, agentId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInboxInvalidate(orgId, agentId);
  return useMutation({
    mutationFn: ({ uid, read }: { uid: number; read: boolean }) =>
      setAgentEmailRead(orgId, agentId, uid, read),
    onMutate: async ({ uid, read }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.agentInbox.listPrefix(orgId, agentId),
      });
      const listSnapshots = queryClient.getQueriesData<AgentInbox>({
        queryKey: queryKeys.agentInbox.listPrefix(orgId, agentId),
      });
      const countSnapshot = queryClient.getQueryData<AgentInboxCount>(
        queryKeys.agentInbox.count(orgId, agentId),
      );
      writeReadStateToCache(queryClient, orgId, agentId, uid, read);
      return { listSnapshots, countSnapshot };
    },
    onError: (err: unknown, _vars, ctx) => {
      for (const [key, data] of ctx?.listSnapshots ?? []) {
        queryClient.setQueryData(key, data);
      }
      if (ctx?.countSnapshot) {
        queryClient.setQueryData(queryKeys.agentInbox.count(orgId, agentId), ctx.countSnapshot);
      }
      toast.error(errMsg(err, "Couldn't update the message"));
    },
    onSettled: () => {
      invalidate();
    },
  });
}

/** Delete a message; the caller decides where focus goes next (advance). */
export function useDeleteEmail(orgId: string, agentId: string, onDeleted?: (uid: number) => void) {
  const invalidate = useInboxInvalidate(orgId, agentId);
  return useMutation({
    mutationFn: (uid: number) => deleteAgentEmail(orgId, agentId, uid),
    onSuccess: (_res, uid) => {
      toast.success("Message deleted");
      invalidate();
      onDeleted?.(uid);
    },
    onError: (err: unknown) => {
      toast.error(errMsg(err, "Couldn't delete message"));
    },
  });
}

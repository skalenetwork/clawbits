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
  getAgentInboxCount,
  setAgentEmailRead,
  type AgentInbox,
  type AgentInboxCount,
} from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";

export const PAGE_SIZE = 50;
export const MAX_LIMIT = 200;
const POLL_MS = 30_000;

export function useAgentInboxList(orgId: string, agentId: string, limit: number) {
  return useQuery({
    queryKey: queryKeys.agentInbox.list(orgId, agentId, limit),
    queryFn: () => getAgentInbox(orgId, agentId, limit),
    refetchInterval: POLL_MS,
    placeholderData: keepPreviousData,
  });
}

export function useAgentInboxCount(orgId: string, agentId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.agentInbox.count(orgId, agentId),
    queryFn: () => getAgentInboxCount(orgId, agentId),
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function useAgentEmail(orgId: string, agentId: string, uid: number) {
  return useQuery({
    queryKey: queryKeys.agentInbox.email(orgId, agentId, uid),
    queryFn: () => getAgentEmail(orgId, agentId, uid),
  });
}

export function useInboxInvalidate(orgId: string, agentId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agentInbox.count(orgId, agentId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.agentInbox.listPrefix(orgId, agentId) });
  };
}

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
      if (!old?.emails.some((e) => e.uid === uid && e.is_read !== read)) return old;
      return { ...old, emails: old.emails.map((e) => (e.uid === uid ? { ...e, is_read: read } : e)) };
    },
  );
  queryClient.setQueryData<AgentInboxCount>(
    queryKeys.agentInbox.count(orgId, agentId),
    (old) => (old ? { ...old, unread: Math.max(0, old.unread + (read ? -1 : 1)) } : old),
  );
}

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

export function useDeleteEmail(orgId: string, agentId: string, onDeleted: (uid: number) => void) {
  const invalidate = useInboxInvalidate(orgId, agentId);
  return useMutation({
    mutationFn: (uid: number) => deleteAgentEmail(orgId, agentId, uid),
    onSuccess: (_res, uid) => {
      toast.success("Message deleted");
      invalidate();
      onDeleted(uid);
    },
    onError: (err: unknown) => {
      toast.error(errMsg(err, "Couldn't delete message"));
    },
  });
}

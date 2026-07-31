import { useQuery } from '@tanstack/react-query';

import { listOrgAgents } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

/** The org's agents. Used by the home screen only to detect a first-run
 *  (empty) workspace; cheap and cached so the empty-org CTAs don't flash. */
export function useOrgAgents(orgId: string | null, enabled = true) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ['org-agents', orgId],
    enabled: token != null && orgId != null && enabled,
    queryFn: () => {
      if (orgId == null) throw new Error('orgId is required');
      return listOrgAgents(token, orgId);
    },
  });
}

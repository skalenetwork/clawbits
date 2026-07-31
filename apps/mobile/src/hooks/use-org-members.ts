import { useQuery } from '@tanstack/react-query';

import { listOrgMembers } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

/** The org's human members. Used by the home screen to detect a first-run
 *  (empty) workspace — an org with no other humans and no agents shows the
 *  "grow your workspace" CTAs instead of the recents grid. */
export function useOrgMembers(orgId: string | null, enabled = true) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ['org-members', orgId],
    enabled: token != null && orgId != null && enabled,
    queryFn: () => {
      if (orgId == null) throw new Error('orgId is required');
      return listOrgMembers(token, orgId);
    },
  });
}

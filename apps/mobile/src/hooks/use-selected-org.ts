import { useQuery } from '@tanstack/react-query';

import { getOrgs, type Org } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

interface UseSelectedOrgResult {
  /** Resolved current org — user's stored selection, then personal, then first available. */
  selectedOrg: Org | null;
  /** Full list of orgs the user belongs to. */
  orgs: Org[];
  /** True while the orgs query is fetching for the first time. */
  isLoading: boolean;
  /** Any error from the orgs query. */
  error: Error | null;
}

/**
 * Single source of truth for "which org am I looking at right now?". Components
 * that need the current org should call this hook rather than re-deriving from
 * `getOrgs` + `auth.selectedOrgId` separately.
 */
export function useSelectedOrg(): UseSelectedOrgResult {
  const { token, selectedOrgId } = useAuth();
  const orgsQuery = useQuery({
    queryKey: ['orgs'],
    queryFn: () => getOrgs(token),
    enabled: token != null,
  });

  const orgs = orgsQuery.data?.organizations ?? [];
  const selectedOrg =
    orgs.find((org) => org.org_id === selectedOrgId) ??
    orgs.find((org) => org.is_personal) ??
    orgs[0] ??
    null;

  return {
    selectedOrg,
    orgs,
    isLoading: orgsQuery.isLoading,
    error: orgsQuery.error,
  };
}

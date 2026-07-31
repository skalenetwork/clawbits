import {useQuery} from "@tanstack/react-query";
import {useAuth} from "@/context/AuthContext";
import {getOrgs, type Org} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";

/**
 * Resolve the active organization for the signed-in user, including the
 * caller's role (``my_role``). Backed by the shared ``queryKeys.orgs``
 * query so this dedupes with the org switcher's fetch — calling it from
 * many places at once is one round-trip per session.
 *
 * Use this anywhere the UI needs to gate admin surfaces. The role comes
 * from the server (see ``OrgResponse.my_role``), and the API enforces
 * the same check independently — this hook is for UX, not security.
 */
export function useActiveOrg(): {
    org: Org | null;
    isOwner: boolean;
    isLoading: boolean;
} {
    const {activeOrgId} = useAuth();
    const orgsQuery = useQuery({
        queryKey: queryKeys.orgs,
        queryFn: () => getOrgs(),
        staleTime: 60_000,
    });
    const org =
        orgsQuery.data?.organizations.find(o => o.org_id === activeOrgId) ?? null;
    return {
        org,
        isOwner: org?.my_role === "owner",
        isLoading: orgsQuery.isLoading,
    };
}

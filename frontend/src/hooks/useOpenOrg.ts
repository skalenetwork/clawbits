import {useQueryClient} from "@tanstack/react-query";
import {useAuth} from "@/context/AuthContext";
import {markOrgVisited, type Org} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";

/** Agent and chat pages belong to one org, so a switch leaves them for home. */
export const orgScoped = (path: string) => /^\/(agents|channels)\//.test(path);

/** Open an org: make it active and clear its unread and new marks at once,
 *  ahead of the server's visited flag. */
export function useOpenOrg(): (orgId: string) => void {
    const {setActiveOrgId} = useAuth();
    const queryClient = useQueryClient();
    return orgId => {
        setActiveOrgId(orgId);
        queryClient.setQueryData<{organizations: Org[]; total: number}>(
            queryKeys.orgs,
            prev => prev && {
                ...prev,
                organizations: prev.organizations.map(o =>
                    o.org_id === orgId
                        ? {...o, last_visited_at: new Date().toISOString(), unread_count: 0, unread_channel_count: 0}
                        : o,
                ),
            },
        );
        void markOrgVisited(orgId).catch(() => undefined);
    };
}

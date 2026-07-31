import {useMutation, useQueryClient} from "@tanstack/react-query";
import {
    deleteAutomation,
    runAutomation,
    updateAutomation,
    type Automation,
} from "@/lib/api";
import {withEnabled} from "@/lib/automations";
import {bumpAutomationsBurst} from "@/lib/automationsPolling";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";

/**
 * The three per-automation write actions shared by the gallery and the detail
 * page. Every write invalidates the whole automations prefix (org + per-agent
 * caches) and tightens the polling burst so the operator watches
 * `requested → applied` land. None of them paints success — the honest amber
 * `requested` state carries the wait.
 */
export function useAutomationMutations(orgId: string, opts?: {
    onDeleted?: (a: Automation) => void;
}) {
    const queryClient = useQueryClient();

    const invalidate = () => {
        bumpAutomationsBurst();
        void queryClient.invalidateQueries({queryKey: queryKeys.automations(orgId)});
    };

    const runNow = useMutation({
        mutationFn: (a: Automation) => runAutomation(orgId, a.agent_id, a.automation_id),
        onSuccess: () => {
            invalidate();
            toast.success("Run requested — the agent picks it up on its next reconcile");
        },
        onError: (err: unknown) => { toast.error(errMsg(err, "Couldn't request a run")); },
    });

    const toggleEnabled = useMutation({
        // PATCH is full-replace: resend the complete spec with only `enabled`
        // flipped so every other field (and the spec_hash) round-trips.
        mutationFn: ({a, enabled}: {a: Automation; enabled: boolean}) => {
            const spec = a.desired_spec;
            if (!spec) throw new Error("This automation has no editable spec");
            return updateAutomation(orgId, a.agent_id, a.automation_id, withEnabled(spec, enabled));
        },
        onSuccess: (_data, {enabled}) => {
            invalidate();
            toast.success(enabled ? "Resuming — pending until the agent confirms" : "Pausing — keeps its configuration");
        },
        onError: (err: unknown) => { toast.error(errMsg(err, "Couldn't update the automation")); },
    });

    const remove = useMutation({
        mutationFn: (a: Automation) => deleteAutomation(orgId, a.agent_id, a.automation_id),
        onSuccess: (_data, a) => {
            invalidate();
            toast.success("Removing — the agent stops it on its next reconcile");
            opts?.onDeleted?.(a);
        },
        onError: (err: unknown) => { toast.error(errMsg(err, "Couldn't remove the automation")); },
    });

    return {runNow, toggleEnabled, remove};
}

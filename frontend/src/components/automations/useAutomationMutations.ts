import { useMutation, useQueryClient } from "@tanstack/react-query";
import { deleteAutomation, runAutomation, updateAutomation, type Automation } from "@/lib/api";
import { withEnabled } from "@/lib/automations";
import { bumpAutomationsBurst } from "@/lib/automationsPolling";
import { queryKeys } from "@/lib/queryKeys";
import { toast } from "@/lib/toast";

export function useAutomationMutations(orgId: string, onDeleted?: () => void) {
  const queryClient = useQueryClient();

  const invalidate = () => {
    bumpAutomationsBurst();
    void queryClient.invalidateQueries({ queryKey: queryKeys.automations(orgId) });
  };

  const runNow = useMutation({
    mutationFn: (a: Automation) => runAutomation(orgId, a.agent_id, a.automation_id),
    onSuccess: () => {
      invalidate();
      toast.success("Run requested, the agent picks it up on its next reconcile");
    },
  });

  const toggleEnabled = useMutation({
    mutationFn: ({ a, enabled }: { a: Automation; enabled: boolean }) => {
      if (!a.desired_spec) throw new Error("This automation has no editable spec");
      return updateAutomation(orgId, a.agent_id, a.automation_id, withEnabled(a.desired_spec, enabled));
    },
    onSuccess: (_data, { enabled }) => {
      invalidate();
      toast.success(enabled ? "Resuming, pending until the agent confirms" : "Pausing, keeps its configuration");
    },
  });

  const remove = useMutation({
    mutationFn: (a: Automation) => deleteAutomation(orgId, a.agent_id, a.automation_id),
    onSuccess: () => {
      invalidate();
      toast.success("Removing, the agent stops it on its next reconcile");
      onDeleted?.();
    },
  });

  return { runNow, toggleEnabled, remove };
}

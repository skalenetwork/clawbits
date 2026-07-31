/**
 * DangerZone — the irreversible delete, kept to one quiet destructive row;
 * the confirmation (and the keep-content choice) lives in DeleteAgentDialog.
 */
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { ManageTile } from "./ManageTile";

export function DangerZone({
  agentName,
  isPending,
  onDelete,
}: {
  agentName: string;
  isPending: boolean;
  onDelete: () => void;
}) {
  return (
    <ManageTile
      icon={Delete02Icon}
      wellClassName="bg-destructive/10 text-destructive"
      title="Delete agent"
      caption={
        <span className="block truncate">
          Removes {agentName} and everything it created - this can&apos;t be undone
        </span>
      }
      className="border-destructive/20"
      control={
        <Button variant="destructive" size="sm" disabled={isPending} onClick={onDelete}>
          {isPending ? "Deleting…" : "Delete agent"}
        </Button>
      }
    />
  );
}

/**
 * The "Add" affordance in a manage section header. Shared by every section that
 * has one so they cannot drift apart: two hand-rolled copies on the same page is
 * how the env section ended up with a different icon and a different weight from
 * the contact allowlist directly above it.
 */
import { Add01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";

export function ManageAddButton({
  onClick,
  disabled = false,
  label = "Add",
}: {
  onClick: () => void;
  disabled?: boolean;
  /** Override only when "Add" would be ambiguous in context. */
  label?: string;
}) {
  return (
    <Button variant="outline" size="xs" onClick={onClick} disabled={disabled}>
      <Icon icon={Add01Icon} className="size-3.5" />
      {label}
    </Button>
  );
}

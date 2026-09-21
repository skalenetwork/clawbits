import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Ban, Check, ChevronDown } from "lucide-react";

import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { MENU_ITEM, MENU_SURFACE } from "@/lib/menuSurface";
import { cn } from "@/lib/utils";

const ROW = cn(MENU_ITEM, "w-full text-left hover:bg-accent focus-visible:bg-accent");

export interface AgentOption {
  id: string;
  label: string;
  avatarUrl?: string | null;
}

export function AgentTargetChip({
  agents,
  targetId,
  open,
  onOpenChange,
  onPick,
  align,
  clearable = false,
}: {
  agents: AgentOption[];
  targetId: string | null;
  open: boolean;
  onOpenChange: (open: boolean, refocus: boolean) => void;
  onPick: (id: string | null) => void;
  align: "start" | "end";
  /** A channel can address no agent at all; a new chat always has one. */
  clearable?: boolean;
}) {
  const target = agents.find((a) => a.id === targetId);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o, { reason }) => { onOpenChange(o, reason === "escape-key"); }}>
      <PopoverPrimitive.Trigger
        render={
          <button
            type="button"
            tabIndex={-1}
            aria-label={target ? `Sending to ${target.label}` : "Send to an agent"}
            className={`flex h-7 min-w-0 max-w-48 items-center gap-1.5 rounded-full px-1.5 text-[13px] font-medium transition-colors hover:bg-foreground/6 data-popup-open:bg-foreground/6 ${target ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {target && <AgentFaceAvatar size={16} name={target.label} src={target.avatarUrl ?? undefined} framed={false}/>}
            <span className="truncate">{target ? target.label : "Agent"}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground"/>
          </button>
        }
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner align={align} side="top" sideOffset={8} className="isolate z-50">
          <PopoverPrimitive.Popup
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
                e.preventDefault();
                onOpenChange(false, true);
              }
            }}
            className={cn("z-50 max-h-72 w-64 origin-(--transform-origin) overflow-y-auto", MENU_SURFACE, "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95")}
          >
            {clearable && (
              <button type="button" onClick={() => { onPick(null); }} className={ROW}>
                <span className="grid size-5 shrink-0 place-items-center"><Ban/></span>
                No agent
                {!target && <Check className="ml-auto text-muted-foreground"/>}
              </button>
            )}
            {agents.map((a) => {
              const active = a.id === targetId;
              return (
                <button key={a.id} type="button" onClick={() => { onPick(active && clearable ? null : a.id); }} className={ROW}>
                  <AgentFaceAvatar size={20} name={a.label} src={a.avatarUrl ?? undefined} framed={false}/>
                  <span className="truncate">{a.label}</span>
                  <span className="truncate text-xs text-muted-foreground">@{a.id}</span>
                  {active && <Check className="ml-auto text-muted-foreground"/>}
                </button>
              );
            })}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

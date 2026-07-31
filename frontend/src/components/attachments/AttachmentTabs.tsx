import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { Icon } from "@/components/Icon";
import { ATTACHMENT_TABS, type AttachmentTab } from "@/lib/attachmentTabs";
import { cn } from "@/lib/utils";

/**
 * Media / Files / Links segmented control for the Attachments sidebar.
 * Same color language as the chat-scope ``ChatTabs`` (translucent popover
 * track, ``foreground/8`` active fill) but stretched to equal thirds, and
 * driven by the attachments tab set. Caller renders the active panel.
 */
export function AttachmentTabs({
  value,
  onValueChange,
}: {
  value: AttachmentTab;
  onValueChange: (tab: AttachmentTab) => void;
}) {
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={(v) => { onValueChange(v as AttachmentTab); }}
      className="w-full"
    >
      <TabsPrimitive.List className="flex w-full items-center justify-center gap-0.5 rounded-lg bg-popover/85 p-0.5 backdrop-blur-xl supports-backdrop-filter:bg-popover/60 supports-backdrop-filter:backdrop-saturate-150">
        {ATTACHMENT_TABS.map((t) => {
          const active = value === t.id;
          return (
            <TabsPrimitive.Tab
              key={t.id}
              value={t.id}
              className={cn(
                "flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap outline-none transition active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/50",
                active
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )}
            >
              <Icon icon={t.icon} className="size-3.5 shrink-0" />
              <span className="truncate">{t.label}</span>
            </TabsPrimitive.Tab>
          );
        })}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

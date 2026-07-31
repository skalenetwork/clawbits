import {Tabs as TabsPrimitive} from "@base-ui/react/tabs";
import {Icon} from "@/components/Icon";
import {CHAT_TABS, type ChatTab} from "@/lib/chatFilters";
import {cn} from "@/lib/utils";

/**
 * The All / Channels / DMs scope filter at the top of the chat list, on both
 * the desktop sidebar and the mobile chats screen. A minimalistic segmented
 * control that borrows the floating bottom-nav's color language: no track, the
 * selected tab gets a soft ``foreground/8`` fill, the rest stay muted and only
 * tint on hover. Built on the Base UI tabs primitive for roving-focus +
 * ``role=tablist`` a11y; the filtered list is rendered by the caller (no panel).
 * (A bare-text "quiet" variant was trialled for the desktop sidebar and
 * reverted — the pill won.)
 *
 * ``fill`` stretches the tabs to equal widths — right for the wide mobile row.
 * Left off (the default) the tabs size to their content and sit left-aligned,
 * which is what fits the narrow desktop sidebar where equal thirds would clip
 * the "Channels" label.
 */
export function ChatTabs({
    value,
    onValueChange,
    fill = false,
    className,
}: {
    value: ChatTab;
    onValueChange: (tab: ChatTab) => void;
    fill?: boolean;
    className?: string;
}) {
    return (
        <TabsPrimitive.Root
            value={value}
            onValueChange={(v) => { onValueChange(v as ChatTab); }}
            className={cn("w-full", className)}
        >
            <TabsPrimitive.List className="flex w-full items-center gap-0.5 rounded-lg bg-popover/85 p-0.5 backdrop-blur-xl supports-backdrop-filter:bg-popover/60 supports-backdrop-filter:backdrop-saturate-150 max-md:rounded-2xl max-md:gap-1 max-md:p-1">
                {CHAT_TABS.map((t) => {
                    const active = value === t.id;
                    return (
                        <TabsPrimitive.Tab
                            key={t.id}
                            value={t.id}
                            className={cn(
                                "flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium whitespace-nowrap outline-none transition active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/50 max-md:rounded-xl max-md:py-2",
                                // ``fill`` (mobile row) = equal thirds; otherwise
                                // grow from content so the tabs fill the full-width
                                // pill edge-to-edge without truncating "Channels".
                                fill ? "min-w-0 flex-1" : "grow",
                                active
                                    ? "bg-foreground/[0.08] text-foreground"
                                    : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                            )}
                        >
                            <Icon icon={t.icon} className="size-3.5 shrink-0"/>
                            <span className="truncate">{t.label}</span>
                        </TabsPrimitive.Tab>
                    );
                })}
            </TabsPrimitive.List>
        </TabsPrimitive.Root>
    );
}

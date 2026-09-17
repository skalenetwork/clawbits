import { Combobox } from "@base-ui/react/combobox";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Astroid, Check, ChevronDown, ChevronsUpDown } from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";

import { Icon } from "@/components/Icon";
import { Scrim } from "@/components/ProgressiveBlur";
import { SELECT_SM } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAgentModels } from "@/hooks/useAgentModels";
import {
  setAgentModel,
  type AgentModels,
  type MmChannelMembersResponse,
  type ModelChoice,
} from "@/lib/api";
import { brandRank, providerBrand } from "@/lib/brands";
import { fuzzyScoreAny } from "@/lib/fuzzy";
import { MENU_ITEM, MENU_LABEL, MENU_SHORTCUT, MENU_SURFACE } from "@/lib/menuSurface";
import { effortOptions, keepThinking, thinkOnLevel, vendorOf } from "@/lib/modelChoice";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

interface ModelGroup {
  vendor: string | null;
  items: (string | null)[];
}

const TRIGGER = {
  pill: "flex h-7 min-w-0 max-w-56 items-center gap-1 rounded-full px-2 text-[13px] font-medium transition-colors hover:bg-foreground/6 hover:text-foreground data-popup-open:bg-foreground/6",
  select: `${SELECT_SM} max-w-64`,
};

const ROW = cn(MENU_ITEM, "pr-8");
const VENDOR_PREFIX = /^([^:]+): /;
const ROW_PX = 32;
const HEAD_PX = 40;

function Glyph({ model }: { model: string | null }) {
  const { Glyph: Mark } = providerBrand(model ? vendorOf(model) : "");
  return (
    <span className="grid size-4 shrink-0 place-items-center">
      {Mark ? <Mark className="size-4"/> : <Astroid className="size-4 text-muted-foreground"/>}
    </span>
  );
}

export function ModelPicker({
  orgId,
  agentId,
  channelId,
  value,
  variant,
  align,
  open,
  onOpenChange,
}: {
  orgId: string;
  agentId: string;
  channelId: string | null;
  value: ModelChoice;
  variant: "pill" | "select";
  align: "start" | "end";
  open: boolean;
  onOpenChange: (open: boolean, refocus: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const modelsKey = queryKeys.agentModels(orgId, agentId);
  const membersKey = queryKeys.mm.channelMembers(channelId ?? "");

  const { data } = useAgentModels(orgId, agentId);

  const mutation = useMutation({
    mutationFn: (choice: ModelChoice) => setAgentModel(orgId, agentId, { channel_id: channelId, ...choice }),
    scope: { id: `model:${agentId}:${channelId ?? ""}` },
    onMutate: (choice) => {
      if (channelId) {
        queryClient.setQueryData<MmChannelMembersResponse>(membersKey, (old) =>
          old && { ...old, members: old.members.map((m) => (m.agent_id === agentId ? { ...m, model_choice: choice } : m)) },
        );
      } else {
        queryClient.setQueryData<AgentModels>(modelsKey, (old) => old && { ...old, default: choice });
      }
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: channelId ? membersKey : modelsKey });
    },
  });

  if (!data?.models) return null;

  const byRef = new Map(data.models.map((m) => [m.ref, m]));
  const nameOf = (ref: string) => byRef.get(ref)?.name.replace(VENDOR_PREFIX, "") ?? ref;
  const names = new Map<string, number>();
  for (const m of data.models) names.set(nameOf(m.ref), (names.get(nameOf(m.ref)) ?? 0) + 1);
  const runtime = data.runtime_default;
  const inherited = (channelId ? data.default.model : null) ?? runtime?.model ?? null;
  const model = value.model ?? inherited;
  const option = model == null ? undefined : byRef.get(model);
  const thinking =
    value.thinking ??
    (channelId ? data.default.thinking : null) ??
    (model === runtime?.model ? runtime?.thinking : option?.default_level) ??
    null;
  const effort = effortOptions(option?.levels ?? []);
  const showEffort = effort.segments.length > 0 && (!effort.think || thinking !== "off");
  const effortLabel = thinking === "off" ? undefined : effort.segments.find((s) => s.level === thinking)?.label;
  const missing = value.model != null && !byRef.has(value.model);
  const own = value.model != null || value.thinking != null;
  const head = HEAD_PX + ROW_PX * (Number(effort.think) + Number(showEffort));

  const q = query.trim().toLowerCase();
  const vendors = new Map<string, { ref: string; score: number }[]>();
  for (const m of data.models) {
    const score = fuzzyScoreAny(q, [m.name.toLowerCase(), m.ref.toLowerCase()]);
    if (score < 0) continue;
    const vendor = vendorOf(m.ref);
    vendors.set(vendor, [...(vendors.get(vendor) ?? []), { ref: m.ref, score }]);
  }
  const groups: ModelGroup[] = [
    ...(q ? [] : [{ vendor: null, items: missing ? [null, value.model] : [null] }]),
    ...[...vendors]
      .sort(([a], [b]) => brandRank(a) - brandRank(b) || a.localeCompare(b))
      .map(([vendor, rows]) => ({ vendor, items: (q ? rows.toSorted((a, b) => b.score - a.score) : rows).map((r) => r.ref) })),
  ];

  const save = (choice: ModelChoice) => {
    if (choice.model !== value.model || choice.thinking !== value.thinking) mutation.mutate(choice);
    input.current?.focus();
  };

  const Chevron = variant === "pill" ? ChevronDown : ChevronsUpDown;

  return (
    <Combobox.Root
      items={groups}
      filter={null}
      autoHighlight
      value={value.model}
      onValueChange={(ref) => {
        const picked = ref == null ? undefined : byRef.get(ref);
        save({ model: ref, thinking: ref == null ? null : picked ? keepThinking(picked, value.thinking) : value.thinking });
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      open={open}
      onOpenChange={(next, { reason }) => {
        if (!next) {
          setQuery("");
          setScrolled(false);
        }
        onOpenChange(next, reason === "escape-key" || reason === "item-press");
      }}
    >
      <Combobox.Trigger
        tabIndex={variant === "pill" ? -1 : undefined}
        aria-label="Model"
        className={cn(TRIGGER[variant], own && !missing ? "text-foreground" : "text-muted-foreground")}
      >
        <span className="truncate">{model == null ? "Default" : nameOf(model)}</span>
        {effortLabel && <span className="shrink-0 font-normal text-muted-foreground">{effortLabel}</span>}
        <Chevron className="ml-0.5 size-3 shrink-0 text-muted-foreground"/>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          align={align}
          side={variant === "pill" ? "top" : "bottom"}
          sideOffset={variant === "pill" ? 8 : 4}
          className="isolate z-50"
        >
          <Combobox.Popup
            aria-label="Model"
            className={cn(
              MENU_SURFACE,
              "z-50 w-76 overflow-hidden p-0 origin-(--transform-origin) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            )}
          >
            <div
              onScroll={(e) => {
                setScrolled(e.currentTarget.scrollTop > 0);
              }}
              className="scrollbar-minimal h-[min(28rem,var(--available-height))] overflow-x-hidden overflow-y-auto overscroll-contain"
              style={{ scrollPaddingTop: head, "--scrollbar-inset": `${String(head)}px` } as CSSProperties}
            >
              <div className="sticky top-0 z-10 pt-1 pl-1.5">
                {scrolled && <Scrim color="popover"/>}
                {effort.think && option && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={thinking !== "off"}
                    onClick={() => {
                      save({ model: value.model, thinking: thinking !== "off" ? "off" : thinkOnLevel(option) });
                    }}
                    className={cn(MENU_ITEM, "w-full hover:bg-accent")}
                  >
                    Think
                    <Switch
                      size="sm"
                      checked={thinking !== "off"}
                      nativeButton={false}
                      render={<span/>}
                      tabIndex={-1}
                      aria-hidden
                      className="pointer-events-none ml-auto"
                    />
                  </button>
                )}
                {showEffort && (
                  <div className={MENU_ITEM}>
                    Effort
                    <div role="radiogroup" aria-label="Effort" className="ml-auto inline-flex rounded-lg bg-input/50 p-0.5">
                      {effort.segments.map((s) => (
                        <button
                          key={s.label}
                          type="button"
                          role="radio"
                          aria-checked={s.level === thinking}
                          onClick={() => {
                            save({ model: value.model, thinking: s.level });
                          }}
                          className={cn(
                            "rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
                            s.level === thinking ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex h-9 items-center gap-2.5 px-2.5">
                  <Icon icon={Search01Icon} className="size-4 shrink-0 text-muted-foreground"/>
                  <Combobox.Input
                    ref={input}
                    placeholder="Search models"
                    aria-label="Search models"
                    className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                  />
                </div>
              </div>
              <Combobox.Empty>
                <div className="px-3.5 py-1.5 text-[13px] text-muted-foreground">No models found</div>
              </Combobox.Empty>
              <Combobox.List className="pb-1 pl-1.5">
                {(group: ModelGroup) => (
                  <Combobox.Group key={group.vendor ?? ""} items={group.items}>
                    {group.vendor && (
                      <Combobox.GroupLabel className={MENU_LABEL}>
                        {providerBrand(group.vendor).label ??
                          byRef.get(group.items[0] ?? "")?.name.match(VENDOR_PREFIX)?.[1] ??
                          group.vendor}
                      </Combobox.GroupLabel>
                    )}
                    <Combobox.Collection>
                      {(ref: string | null) => {
                        const row = ref == null ? undefined : byRef.get(ref);
                        const hint =
                          ref != null && !row
                            ? "Unavailable"
                            : row && (names.get(nameOf(row.ref)) ?? 0) > 1
                              ? providerBrand(row.provider).label ?? row.provider
                              : null;
                        return (
                          <Combobox.Item
                            key={ref ?? ""}
                            value={ref}
                            className={cn(ROW, ref == null && "py-1.5", ref != null && !row && "text-muted-foreground")}
                          >
                            <Glyph model={ref ?? inherited}/>
                            {ref == null ? (
                              <span className="flex min-w-0 flex-col leading-[18px]">
                                Default
                                {inherited && <span className="truncate text-xs text-muted-foreground">{nameOf(inherited)}</span>}
                              </span>
                            ) : (
                              <span className="min-w-0 truncate">{nameOf(ref)}</span>
                            )}
                            {hint && <span className={cn(MENU_SHORTCUT, "shrink-0 whitespace-nowrap")}>{hint}</span>}
                            <Combobox.ItemIndicator className="absolute right-2.5 flex">
                              <Check className="text-muted-foreground"/>
                            </Combobox.ItemIndicator>
                          </Combobox.Item>
                        );
                      }}
                    </Combobox.Collection>
                  </Combobox.Group>
                )}
              </Combobox.List>
            </div>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

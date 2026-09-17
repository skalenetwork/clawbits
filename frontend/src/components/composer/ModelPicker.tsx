import { Combobox } from "@base-ui/react/combobox";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronsUpDown } from "lucide-react";
import { useState } from "react";

import { SELECT_SM } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  getAgentModels,
  setAgentModel,
  type AgentModels,
  type MmChannelMembersResponse,
  type ModelChoice,
} from "@/lib/api";
import { providerBrand } from "@/lib/brands";
import { fuzzyScoreAny } from "@/lib/fuzzy";
import { MENU_ITEM, MENU_LABEL, MENU_SEPARATOR, MENU_SHORTCUT, MENU_SURFACE } from "@/lib/menuSurface";
import { effortOptions, keepThinking, thinkOnLevel, vendorOf } from "@/lib/modelChoice";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

interface ModelGroup {
  vendor: string | null;
  items: (string | null)[];
}

const TRIGGER = {
  pill: "flex h-7 min-w-0 max-w-48 items-center gap-1.5 rounded-lg px-1.5 text-[13px] font-medium transition-colors hover:bg-foreground/6 hover:text-foreground data-popup-open:bg-foreground/6",
  select: `${SELECT_SM} max-w-56`,
};

const ROW = cn(MENU_ITEM, "pr-8");

const VENDOR_PREFIX = /^([^:]+): /;

export const agentModelsQuery = (orgId: string, agentId: string) =>
  queryOptions({
    queryKey: queryKeys.agentModels(orgId, agentId),
    queryFn: () => getAgentModels(orgId, agentId),
    staleTime: 10 * 60_000,
  });

function ModelGlyph({ model }: { model: string | null }) {
  const { Glyph } = providerBrand(model ? vendorOf(model) : "");
  return Glyph ? <Glyph className="size-3.5 shrink-0"/> : null;
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
  const modelsKey = queryKeys.agentModels(orgId, agentId);
  const membersKey = queryKeys.mm.channelMembers(channelId ?? "");

  const { data } = useQuery(agentModelsQuery(orgId, agentId));

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
  const missing = value.model != null && !byRef.has(value.model);
  const own = value.model != null || value.thinking != null;
  const suffix = thinking === "off" ? undefined : effort.segments.find((s) => s.level === thinking)?.label;

  const q = query.trim().toLowerCase();
  const ranked = data.models
    .map((m) => ({ ref: m.ref, score: fuzzyScoreAny(q, [m.name.toLowerCase(), m.ref.toLowerCase()]) }))
    .filter((m) => m.score >= 0)
    .sort((a, b) => b.score - a.score);
  const vendors = new Map<string, string[]>();
  for (const { ref } of ranked) {
    const vendor = vendorOf(ref);
    vendors.set(vendor, [...(vendors.get(vendor) ?? []), ref]);
  }
  const groups: ModelGroup[] = [
    ...(q ? [] : [{ vendor: null, items: missing ? [null, value.model] : [null] }]),
    ...Array.from(vendors, ([vendor, items]) => ({ vendor, items })),
  ];

  const save = (choice: ModelChoice) => {
    if (choice.model !== value.model || choice.thinking !== value.thinking) mutation.mutate(choice);
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
        if (!next) setQuery("");
        onOpenChange(next, reason === "escape-key" || reason === "item-press");
      }}
    >
      <Combobox.Trigger
        tabIndex={variant === "pill" ? -1 : undefined}
        aria-label="Model"
        className={cn(TRIGGER[variant], own && !missing ? "text-foreground" : "text-muted-foreground")}
      >
        <ModelGlyph model={model}/>
        <span className="truncate">
          {model == null ? "Default" : nameOf(model)}
          {suffix && ` · ${suffix}`}
        </span>
        <Chevron className="size-3 shrink-0 text-muted-foreground"/>
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
              "z-50 w-72 origin-(--transform-origin) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            )}
          >
            <Combobox.Input
              placeholder="Search models"
              aria-label="Search models"
              className="h-8 w-full bg-transparent px-2.5 text-[13px] outline-none placeholder:text-muted-foreground"
            />
            <div className={MENU_SEPARATOR}/>
            <Combobox.Empty>
              <div className="px-2.5 py-1.5 text-[13px] text-muted-foreground">No models found</div>
            </Combobox.Empty>
            <Combobox.List className="max-h-72 scroll-py-1 overflow-y-auto overscroll-contain">
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
                      const shortcut =
                        ref == null
                          ? inherited && nameOf(inherited)
                          : !row
                            ? "Unavailable"
                            : row.provider === vendorOf(ref)
                              ? null
                              : `via ${providerBrand(row.provider).label ?? row.provider}`;
                      return (
                        <Combobox.Item
                          key={ref ?? ""}
                          value={ref}
                          className={cn(ROW, ref != null && !row && "text-muted-foreground")}
                        >
                          <span className="grid size-4 shrink-0 place-items-center">
                            <ModelGlyph model={ref ?? inherited}/>
                          </span>
                          <span className="truncate">{ref == null ? "Default" : nameOf(ref)}</span>
                          {shortcut && <span className={cn(MENU_SHORTCUT, "shrink-0 whitespace-nowrap")}>{shortcut}</span>}
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
            {option && (effort.think || effort.segments.length > 0) && (
              <>
                <div className={MENU_SEPARATOR}/>
                <div className="flex h-8 items-center gap-3 px-2.5">
                  {effort.think && (
                    <label className="flex items-center gap-2 text-[13px]">
                      Think
                      <Switch
                        size="sm"
                        checked={thinking !== "off"}
                        onCheckedChange={(on) => {
                          save({ model: value.model, thinking: on ? thinkOnLevel(option) : "off" });
                        }}
                      />
                    </label>
                  )}
                  {effort.segments.length > 0 && (!effort.think || thinking !== "off") && (
                    <div className="ml-auto inline-flex rounded-lg bg-input/50 p-0.5">
                      {effort.segments.map((s) => (
                        <button
                          key={s.label}
                          type="button"
                          aria-pressed={s.level === thinking}
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
                  )}
                </div>
              </>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

import {useState, type ReactNode} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {Clock05Icon as Clock, RepeatIcon as Repeat} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {useIsMobile} from "@/hooks/use-mobile";
import {useAgentStatus} from "@/hooks/useAgentPresence";
import {useNow} from "@/hooks/useNow";
import {
    createAutomation,
    listAgentChannels,
    updateAutomation,
    type AgentDeliveryChannel,
    type AgentUser,
    type Automation,
} from "@/lib/api";
import {
    ACCENT_BG,
    accentForId,
    buildDesiredSpec,
    type AutomationTemplate,
} from "@/lib/automations";
import {bumpAutomationsBurst} from "@/lib/automationsPolling";
import {
    cronValid,
    describeSchedule,
    localTimezone,
    parseSchedule,
    type Schedule,
} from "@/lib/schedule";
import {agentDisplay} from "@/lib/agentDisplay";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";
import {cn} from "@/lib/utils";
import {Button} from "@/components/ui/button";
import {Label} from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectGroupLabel,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {Dialog, DialogContent, DialogTitle} from "@/components/ui/dialog";
import {Drawer, DrawerContent, DrawerTitle} from "@/components/ui/drawer";
import {ScheduleComposer} from "@/components/automations/ScheduleComposer";

interface SpecShape {
    name?: string;
    payload?: {message?: string};
    schedule?: Record<string, unknown>;
    delivery?: {to?: string};
}

function channelOptionLabel(c: AgentDeliveryChannel): string {
    if (c.channel_type === "direct") return c.display_name ?? c.name;
    const prefix = c.channel_type === "private" ? "🔒 " : "# ";
    return prefix + (c.display_name ?? c.name);
}

function initialForgeSchedule(
    editing: Automation | null,
    editSpec: SpecShape | undefined,
    template: AutomationTemplate | null,
): Schedule {
    if (editing) {
        return parseSchedule(editSpec?.schedule) ?? {kind: "cron", expr: "0 9 * * *", tz: localTimezone()};
    }
    const s = template?.defaultSchedule ?? {kind: "cron", expr: "0 9 * * *"};
    return s.kind === "cron" && !s.tz ? {...s, tz: localTimezone()} : s;
}

function scheduleIsSaveable(s: Schedule, nowMs: number): boolean {
    switch (s.kind) {
        case "cron":
            return cronValid(s.expr, s.tz);
        case "at":
            return s.at > nowMs;
        case "every":
            return s.everyMs > 0;
    }
}

interface ForgeProps {
    orgId: string;
    template: AutomationTemplate | null;
    editing: Automation | null;
    agent: AgentUser;
    onOpenChange: (open: boolean) => void;
}

export function ForgeDialog({orgId, template, editing, agent, onOpenChange}: ForgeProps) {
    const isMobile = useIsMobile();
    const open = template != null || editing != null;
    const [cached, setCached] = useState<{
        template: AutomationTemplate | null;
        editing: Automation | null;
    }>({template: null, editing: null});
    const [epoch, setEpoch] = useState(0);
    const [wasOpen, setWasOpen] = useState(false);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) {
            setCached({template, editing});
            setEpoch(e => e + 1);
        }
    }
    const keyId = cached.editing?.automation_id ?? cached.template?.id ?? "none";
    const form = (cached.template ?? cached.editing) ? (
        <ForgeForm
            key={`${keyId}:${String(epoch)}`}
            orgId={orgId}
            template={cached.template}
            editing={cached.editing}
            agent={agent}
            onOpenChange={onOpenChange}
        />
    ) : null;

    if (isMobile) {
        return (
            <Drawer open={open} onOpenChange={onOpenChange}>
                <DrawerContent>{form}</DrawerContent>
            </Drawer>
        );
    }
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:max-w-xl"
                style={{maxHeight: "min(44rem, calc(100dvh - 4rem))"}}
            >
                {form}
            </DialogContent>
        </Dialog>
    );
}

function ForgeForm({orgId, template, editing, agent, onOpenChange}: ForgeProps) {
    const isMobile = useIsMobile();
    const queryClient = useQueryClient();
    const isEdit = editing != null;
    const editSpec = (editing?.desired_spec ?? undefined) as SpecShape | undefined;

    const [name, setName] = useState(
        editing ? editSpec?.name ?? editing.name ?? "" : template?.defaultName ?? "",
    );
    const [prompt, setPrompt] = useState(
        editing ? editSpec?.payload?.message ?? "" : template?.prompt ?? "",
    );
    const [schedule, setSchedule] = useState<Schedule>(() =>
        initialForgeSchedule(editing, editSpec, template),
    );
    const [scheduleValid, setScheduleValid] = useState(() => scheduleIsSaveable(schedule, Date.now()));
    const [channelId, setChannelId] = useState(editSpec?.delivery?.to ?? "");

    const now = useNow(30_000);
    const agentStatus = useAgentStatus(agent.agent_id, agent.last_alive_at ?? null);
    const agentName = agentDisplay(agent);

    const channelsQuery = useQuery({
        queryKey: queryKeys.agentChannels(orgId, agent.agent_id),
        queryFn: () => listAgentChannels(orgId, agent.agent_id),
    });
    const channels = channelsQuery.data?.channels ?? [];
    const channelGroups = [
        {label: "Channels", channels: channels.filter(c => c.channel_type !== "direct")},
        {label: "Direct messages", channels: channels.filter(c => c.channel_type === "direct")},
    ];
    const targetMissing =
        channelId !== "" &&
        channelsQuery.isSuccess &&
        !channels.some(c => c.channel_id === channelId);
    const channelItems: Record<string, ReactNode> = {"": "Direct message with you (default)"};
    for (const c of channels) channelItems[c.channel_id] = channelOptionLabel(c);
    if (targetMissing) channelItems[channelId] = "⚠ Previously selected channel";

    const mutation = useMutation({
        mutationFn: () => {
            const spec = buildDesiredSpec({
                name,
                prompt,
                schedule,
                channelId: channelId || null,
                base: editing?.desired_spec ?? null,
            });
            return editing
                ? updateAutomation(orgId, editing.agent_id, editing.automation_id, spec)
                : createAutomation(orgId, agent.agent_id, spec);
        },
        onSuccess: () => {
            bumpAutomationsBurst();
            void queryClient.invalidateQueries({queryKey: queryKeys.automations(orgId)});
            toast.success(`Sent to ${agentName}, pending until it confirms`);
            onOpenChange(false);
        },
        onError: (err: unknown) => {
            toast.error(errMsg(err, isEdit ? "Couldn't update automation" : "Couldn't create automation"));
        },
    });

    const canSave =
        name.trim().length > 0 &&
        prompt.trim().length > 0 &&
        scheduleValid &&
        (schedule.kind !== "at" || schedule.at > now) &&
        !mutation.isPending;

    const accent = editing
        ? accentForId(editing.automation_id)
        : template?.accent ?? "blue";

    const title = isEdit ? "Edit automation" : "New automation";
    return (
        <>
            {isMobile ? (
                <DrawerTitle className="sr-only">{title}</DrawerTitle>
            ) : (
                <DialogTitle className="sr-only">{title}</DialogTitle>
            )}
            <form
                id="forge-form"
                className={cn(
                    "min-h-0 space-y-5 overflow-y-auto",
                    isMobile ? "flex-1 px-1 pt-3" : "p-6",
                )}
                onSubmit={(e) => {
                    e.preventDefault();
                    if (canSave) mutation.mutate();
                }}
            >
                <div className="flex items-start gap-4 pr-8">
                    <span
                        className={cn(
                            "relative flex size-14 shrink-0 items-center justify-center rounded-2xl text-white",
                            ACCENT_BG[accent],
                        )}
                    >
                        <Icon icon={template?.icon ?? Clock} className="size-7"/>
                        <AgentFaceAvatar
                            size={20}
                            name={agentName}
                            src={agent.avatar?.url}
                            className="absolute -bottom-1 -right-1 rounded-full ring-2 ring-popover"
                        />
                    </span>
                    <div className="min-w-0 flex-1 self-center">
                        <input
                            id="forge-name"
                            aria-label="Automation name"
                            value={name}
                            maxLength={80}
                            onChange={(e) => { setName(e.target.value); }}
                            placeholder="Name your automation"
                            className="w-full min-w-0 border-none bg-transparent text-xl font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground/40"
                        />
                        <p className="mt-1 flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
                            <Icon icon={Repeat} className="size-3.5 shrink-0 opacity-70"/>
                            <span className="truncate">
                                {scheduleValid ? describeSchedule(schedule) : "Pick a schedule below"}
                            </span>
                        </p>
                    </div>
                </div>

                {agentStatus !== "available" && (
                    <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-snug text-amber-700 dark:text-amber-400">
                        {agentName} is offline. The automation applies when it reconnects.
                    </p>
                )}

                <textarea
                    id="forge-prompt"
                    aria-label="Prompt"
                    className={cn(
                        "min-h-[220px] w-full min-w-0 resize-y rounded-xl bg-muted/40 p-4",
                        "text-base leading-relaxed text-foreground outline-none",
                        "transition-shadow placeholder:text-muted-foreground/50",
                        "focus-visible:ring-2 focus-visible:ring-ring/30",
                    )}
                    value={prompt}
                    onChange={(e) => { setPrompt(e.target.value); }}
                    placeholder="What should the agent do each run?"
                />

                <div className="space-y-2">
                    <Label>When</Label>
                    <ScheduleComposer
                        value={schedule}
                        now={now}
                        onChange={(next, valid) => {
                            setSchedule(next);
                            setScheduleValid(valid);
                        }}
                    />
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="forge-target">Post results to</Label>
                    <Select
                        value={channelId}
                        onValueChange={(next: string | null) => { setChannelId(next ?? ""); }}
                        items={channelItems}
                    >
                        <SelectTrigger id="forge-target" disabled={channelsQuery.isLoading}>
                            <SelectValue/>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="">Direct message with you (default)</SelectItem>
                            {targetMissing && (
                                <SelectItem value={channelId}>⚠ Previously selected channel (agent may have left)</SelectItem>
                            )}
                            {channelGroups.map(g => g.channels.length > 0 && (
                                <SelectGroup key={g.label}>
                                    <SelectGroupLabel>{g.label}</SelectGroupLabel>
                                    {g.channels.map(c => (
                                        <SelectItem key={c.channel_id} value={c.channel_id}>
                                            {channelOptionLabel(c)}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </form>
            <div className={cn(
                "flex shrink-0 items-center justify-end gap-2",
                isMobile
                    ? "sticky bottom-0 -mx-1 bg-popover/95 px-2 py-3 supports-backdrop-filter:bg-popover/80 supports-backdrop-filter:backdrop-blur-xl"
                    : "px-6 pb-6 pt-2",
            )}>
                <Button type="submit" size="lg" form="forge-form" disabled={!canSave}>
                    {mutation.isPending ? "Sending…" : isEdit ? "Save" : "Automate"}
                </Button>
            </div>
        </>
    );
}

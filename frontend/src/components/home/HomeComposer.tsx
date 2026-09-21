import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronDown } from "lucide-react";

import { AgentTargetChip } from "@/components/composer/AgentTargetChip";
import { ModelPicker } from "@/components/composer/ModelPicker";
import { HOME_SURFACE } from "@/components/home/tiles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/context/AuthContext";
import {
  createMmAgentChat,
  createMmChannelPost,
  createOrGetMmDirect,
  setAgentModel,
  type AgentUser,
  type ModelChoice,
} from "@/lib/api";
import { frecencyKey, recordVisit } from "@/lib/frecency";
import { HOME_DRAFT_KEY, draftStore } from "@/lib/messageDrafts";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const MAX_LEN = 4000;
const INHERIT: ModelChoice = { model: null, thinking: null };

const CHIP =
  "flex h-7 min-w-0 items-center gap-1 rounded-full px-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-foreground/6 hover:text-foreground data-popup-open:bg-foreground/6";

const DESTINATIONS = [
  { value: "session", label: "New session" },
  { value: "direct", label: "Direct message" },
] as const;

type Destination = (typeof DESTINATIONS)[number]["value"];

function agentName(agent: AgentUser): string {
  return agent.display_name?.trim() || agent.nickname?.trim() || agent.agent_id;
}

function DestinationChip({
  value,
  onPick,
}: {
  value: Destination;
  onPick: (value: Destination) => void;
}) {
  const current = DESTINATIONS.find((d) => d.value === value) ?? DESTINATIONS[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        tabIndex={-1}
        aria-label={`Destination: ${current.label}`}
        className={CHIP}
      >
        <span className="truncate">{current.label}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground"/>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="min-w-44">
        {DESTINATIONS.map((d) => (
          <DropdownMenuItem key={d.value} onClick={() => { onPick(d.value); }}>
            <span className="flex-1">{d.label}</span>
            {d.value === value && <Check className="size-4 text-muted-foreground"/>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Home's opening move: write the message first, and the chat is created around
 *  it on send. ``agents`` is already filtered to the ones you may contact and
 *  ranked, so the head of the list is the agent you last reached for. */
export function HomeComposer({ orgId, agents }: { orgId: string; agents: AgentUser[] }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [stored] = useState(() => (userId == null ? null : draftStore.get(userId, HOME_DRAFT_KEY)));
  const [draft, setDraft] = useState(() => stored?.text ?? "");
  const [picked, setPicked] = useState<string | null>(() => stored?.targetAgentId ?? null);
  const [destination, setDestination] = useState<Destination>("session");
  const [model, setModel] = useState<ModelChoice>(INHERIT);
  const [agentOpen, setAgentOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

  const agent = agents.find((a) => a.agent_id === picked) ?? agents[0] ?? null;

  const start = useMutation({
    mutationFn: async ({ text, agent: to }: { text: string; agent: AgentUser }) => {
      const channel =
        destination === "direct"
          ? await createOrGetMmDirect(orgId, "agent", to.agent_id)
          : await createMmAgentChat(orgId, to.agent_id);
      // The override belongs to this chat alone; the agent's own default is left as it was.
      if (model.model != null || model.thinking != null) {
        await setAgentModel(orgId, to.agent_id, { channel_id: channel.channel_id, ...model });
      }
      await createMmChannelPost(channel.channel_id, text);
      return channel;
    },
    onSuccess: (channel, { agent: to }) => {
      setDraft("");
      if (userId != null) draftStore.clear(userId, HOME_DRAFT_KEY);
      recordVisit(frecencyKey("agent", to.agent_id));
      void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      void navigate(`/channels/${channel.channel_id}`);
    },
    onError: (e) => {
      toast.error(errMsg(e, "Couldn't start the chat"));
      inputRef.current?.focus();
    },
  });

  useEffect(() => {
    if (userId != null) draftStore.set(userId, HOME_DRAFT_KEY, { text: draft, reply: null, targetAgentId: picked });
  }, [userId, draft, picked]);

  useEffect(() => () => { draftStore.flush(); }, []);

  // Type anywhere on home and the message takes it, as in a channel — except a
  // bare digit, which belongs to the tiles below and is the only key they own.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const input = inputRef.current;
      if (
        ["TEXTAREA", "INPUT", "SELECT"].includes(target.tagName) ||
        target.isContentEditable ||
        e.metaKey || e.ctrlKey || e.altKey ||
        (e.key.length !== 1 && e.key !== "Dead") ||
        /^[0-9]$/.test(e.key) ||
        e.isComposing ||
        window.getSelection()?.toString() ||
        document.querySelector('[role="dialog"][data-state="open"]') ||
        window.matchMedia("(pointer: coarse)").matches ||
        !input ||
        document.activeElement === input
      ) return;
      // No preventDefault: the keystroke lands in the now-focused textarea.
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, []);

  if (!agent) return null;

  const canSend = draft.trim() !== "" && !start.isPending;

  const refocus = () => {
    requestAnimationFrame(() => { inputRef.current?.focus(); });
  };

  const pick = (id: string | null) => {
    setPicked(id);
    // A model ref only means something to the agent that reported it.
    setModel(INHERIT);
  };

  const submit = () => {
    if (!canSend) return;
    start.mutate({ text: draft.trim(), agent });
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
      e.preventDefault();
      if (!e.shiftKey) {
        setAgentOpen((v) => !v);
        return;
      }
      const next = agents[(agents.findIndex((a) => a.agent_id === agent.agent_id) + 1) % agents.length];
      if (next) pick(next.agent_id);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      inputRef.current?.blur();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cn(HOME_SURFACE, "flex flex-col gap-1.5 px-2.5 pt-3 pb-2.5 transition-colors focus-within:border-border/80")}
    >
      <div className="grid min-w-0 px-1.5">
        <div
          aria-hidden="true"
          className="pointer-events-none invisible [grid-area:1/1] max-h-[40vh] min-h-15 overflow-hidden break-words whitespace-pre-wrap text-[14px] leading-5"
        >
          {draft}{" "}
        </div>
        <textarea
          ref={inputRef}
          rows={3}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); }}
          onKeyDown={handleKeyDown}
          placeholder={`What should ${agentName(agent)} work on?`}
          maxLength={MAX_LEN}
          spellCheck
          aria-label="Start a chat"
          className="[grid-area:1/1] block w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-[14px] leading-5 text-foreground shadow-none outline-none selection:bg-primary/20 placeholder:text-muted-foreground focus-visible:ring-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        />
      </div>
      <div className="flex min-w-0 items-center gap-0.5">
        <AgentTargetChip
          agents={agents.map((a) => ({ id: a.agent_id, label: agentName(a), avatarUrl: a.avatar?.url }))}
          targetId={agent.agent_id}
          open={agentOpen}
          onOpenChange={(open, back) => {
            setAgentOpen(open);
            if (back) refocus();
          }}
          align="start"
          onPick={(id) => {
            pick(id);
            setAgentOpen(false);
            refocus();
          }}
        />
        <DestinationChip
          value={destination}
          onPick={(d) => {
            setDestination(d);
            refocus();
          }}
        />
        <ModelPicker
          orgId={orgId}
          agentId={agent.agent_id}
          channelId={null}
          value={model}
          onChange={setModel}
          variant="pill"
          align="start"
          open={modelOpen}
          onOpenChange={(open, back) => {
            setModelOpen(open);
            if (back) refocus();
          }}
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Start chat"
          className={`ml-auto grid size-7 shrink-0 place-items-center rounded-full transition-all disabled:cursor-not-allowed ${
            canSend
              ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95"
              : "bg-foreground/10 text-muted-foreground"
          }`}
        >
          {start.isPending ? (
            <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"/>
          ) : (
            <ArrowUp className="size-4"/>
          )}
        </button>
      </div>
    </form>
  );
}

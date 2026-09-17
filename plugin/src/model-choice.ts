import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CHANNEL_ID } from "./accounts.js";
import { type BasicLogger, logWarn } from "./file-logger.js";

type PluginRuntime = OpenClawPluginApi["runtime"];
type SessionEntry = NonNullable<ReturnType<PluginRuntime["agent"]["session"]["getSessionEntry"]>>;
type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];

export type ModelChoice = { model: string | null; thinking: string | null };

export interface ModelSelection {
  agentDefault: ModelChoice;
  channels: ReadonlyMap<string, ModelChoice>;
}

interface ChoicePatch {
  model: string | null | undefined;
  thinking: string | null | undefined;
  applied: ModelChoice;
}

export interface ModelChoiceStore {
  getChoice(accountId: string, key: string): ModelChoice | undefined;
  setChoice(accountId: string, key: string, choice: ModelChoice): Promise<void>;
}

export const INHERIT: ModelChoice = { model: null, thinking: null };

let runtime: PluginRuntime | undefined;

export function setModelChoiceRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function choiceOf(model: unknown, thinking: unknown): ModelChoice {
  return {
    model: typeof model === "string" ? model : null,
    thinking: typeof thinking === "string" ? thinking : null,
  };
}

function nextValue(current: string | null, desired: string | null, applied: string | null) {
  if (desired !== null) return current === desired ? undefined : desired;
  return current !== null && current === applied ? null : undefined;
}

function planChoice(current: ModelChoice, desired: ModelChoice, applied: ModelChoice): ChoicePatch | null {
  const model = nextValue(current.model, desired.model, applied.model);
  const thinking = nextValue(current.thinking, desired.thinking, applied.thinking);
  if (model === undefined && thinking === undefined) return null;
  return {
    model,
    thinking,
    applied: {
      model: model === undefined ? applied.model : model,
      thinking: thinking === undefined ? applied.thinking : thinking,
    },
  };
}

function sessionModel(entry: SessionEntry | undefined): string | null {
  if (entry?.modelOverrideFallbackOriginProvider && entry.modelOverrideFallbackOriginModel) {
    return `${entry.modelOverrideFallbackOriginProvider}/${entry.modelOverrideFallbackOriginModel}`;
  }
  return entry?.providerOverride && entry.modelOverride
    ? `${entry.providerOverride}/${entry.modelOverride}`
    : null;
}

function splitRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf("/");
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

function appliedChoice(entry: SessionEntry | undefined): ModelChoice {
  const stamp = entry?.pluginExtensions?.clawbits?.modelChoice;
  return stamp && typeof stamp === "object" && !Array.isArray(stamp)
    ? choiceOf(stamp.model, stamp.thinking)
    : INHERIT;
}

export function planSessionPatch(entry: SessionEntry | undefined, desired: ModelChoice): ChoicePatch | null {
  const model = entry?.modelSelectionLocked ? desired.model : sessionModel(entry);
  return planChoice({ model, thinking: entry?.thinkingLevel ?? null }, desired, appliedChoice(entry));
}

function rosterEntry(cfg: OpenClawConfig, agentId: string): AgentEntry | undefined {
  const agents = cfg.agents;
  if (agents?.entries !== undefined) {
    const key = Object.keys(agents.entries).find((id) => id.trim().toLowerCase() === agentId);
    return key === undefined ? undefined : agents.entries[key];
  }
  return agents?.list?.find((entry) => entry.id.trim().toLowerCase() === agentId);
}

function rosterChoice(cfg: OpenClawConfig, agentId: string): ModelChoice {
  const entry = rosterEntry(cfg, agentId);
  const model = typeof entry?.model === "string" ? entry.model : entry?.model?.primary;
  return { model: model ?? null, thinking: entry?.thinkingDefault ?? null };
}

async function loadSdk(): Promise<
  Partial<typeof import("openclaw/plugin-sdk/agent-runtime")> &
    Partial<typeof import("openclaw/plugin-sdk/model-session-runtime")>
> {
  const [agentRuntime, sessionRuntime] = await Promise.all([
    import("openclaw/plugin-sdk/agent-runtime").catch(() => ({})),
    import("openclaw/plugin-sdk/model-session-runtime").catch(() => ({})),
  ]);
  return { ...agentRuntime, ...sessionRuntime };
}

export function operatorDmRoute(accountId: string): { agentId: string; sessionKey?: string } | undefined {
  if (
    typeof runtime?.channel?.routing?.resolveAgentRoute !== "function" ||
    typeof runtime.config?.current !== "function"
  ) {
    return undefined;
  }
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: runtime.config.current() as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId,
  });
  return {
    agentId: route.agentId,
    ...((route.dmScope ?? "main") === "main" ? { sessionKey: route.sessionKey } : {}),
  };
}

async function patchSession(
  target: { agentId: string; sessionKey: string },
  desired: ModelChoice,
): Promise<void> {
  const { resolveDefaultModelForAgent, applyModelOverrideWithAuthProfileCompatibility } = await loadSdk();
  const agent = runtime?.agent;
  if (
    !resolveDefaultModelForAgent ||
    !applyModelOverrideWithAuthProfileCompatibility ||
    typeof agent?.session?.getSessionEntry !== "function" ||
    typeof agent.session.patchSessionEntry !== "function" ||
    typeof agent.resolveAgentDir !== "function" ||
    typeof runtime?.config?.current !== "function"
  ) {
    return;
  }
  const existing = agent.session.getSessionEntry(target);
  if (!planSessionPatch(existing, desired)) return;
  const cfg = runtime.config.current() as OpenClawConfig;
  const fallback = resolveDefaultModelForAgent({ cfg, agentId: target.agentId });
  const agentDir = agent.resolveAgentDir(cfg, target.agentId);
  await agent.session.patchSessionEntry({
    ...target,
    replaceEntry: true,
    ...(existing ? {} : { fallbackEntry: { sessionId: randomUUID(), updatedAt: Date.now() } }),
    update: (entry) => {
      const patch = planSessionPatch(entry, desired);
      if (!patch) return null;
      if (patch.model !== undefined) {
        applyModelOverrideWithAuthProfileCompatibility({
          cfg,
          agentDir,
          entry,
          currentProvider: entry.providerOverride ?? entry.modelProvider ?? fallback.provider,
          selection:
            patch.model === null
              ? { ...fallback, isDefault: true }
              : { ...splitRef(patch.model), isDefault: false },
        });
      }
      if (patch.thinking === null) delete entry.thinkingLevel;
      else if (patch.thinking !== undefined) entry.thinkingLevel = patch.thinking;
      entry.pluginExtensions = {
        ...entry.pluginExtensions,
        clawbits: { ...entry.pluginExtensions?.clawbits, modelChoice: { ...patch.applied } },
      };
      return entry;
    },
  });
}

export async function convergeSession(
  target: { agentId: string; sessionKey: string },
  desired: ModelChoice,
  log?: BasicLogger,
): Promise<void> {
  try {
    await patchSession(target, desired).catch((err: unknown) => {
      if ((err as Error)?.name !== "SqliteSessionMutationConflictError") throw err;
      return patchSession(target, desired);
    });
  } catch (err) {
    logWarn(log, `[clawbits] model choice not applied to ${target.sessionKey}: ${String((err as Error)?.message ?? err)}`);
  }
}

let agentDefaultWrites = Promise.resolve();

export function convergeAgentDefault(
  target: { accountId: string; agentId: string },
  desired: ModelChoice,
  store: ModelChoiceStore,
  log?: BasicLogger,
): Promise<void> {
  agentDefaultWrites = agentDefaultWrites.then(() => writeAgentDefault(target, desired, store, log));
  return agentDefaultWrites;
}

async function writeAgentDefault(
  target: { accountId: string; agentId: string },
  desired: ModelChoice,
  store: ModelChoiceStore,
  log?: BasicLogger,
): Promise<void> {
  const key = `model:${target.agentId}`;
  try {
    const { setAgentEffectiveModelPrimary } = await loadSdk();
    const config = runtime?.config;
    const normalize = runtime?.agent?.normalizeThinkingLevel;
    if (
      !setAgentEffectiveModelPrimary ||
      typeof config?.current !== "function" ||
      typeof config.mutateConfigFile !== "function" ||
      typeof normalize !== "function"
    ) {
      return;
    }
    const current = rosterChoice(config.current() as OpenClawConfig, target.agentId);
    const plan = planChoice(current, desired, store.getChoice(target.accountId, key) ?? INHERIT);
    const thinking = plan?.thinking ? normalize(plan.thinking) : undefined;
    if (!plan || (plan.thinking && !thinking)) return;
    await config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        if (plan.model) {
          setAgentEffectiveModelPrimary(draft, target.agentId, plan.model, { target: "agent" });
        } else if (thinking && draft.agents?.entries === undefined && draft.agents?.list === undefined) {
          draft.agents = { ...draft.agents, entries: { [target.agentId]: {} } };
        }
        const entry = rosterEntry(draft, target.agentId);
        if (!entry) return;
        if (plan.model === null) {
          if (typeof entry.model === "object") delete entry.model.primary;
          if (typeof entry.model === "string" || Object.keys(entry.model ?? {}).length === 0) delete entry.model;
        }
        if (plan.thinking === null) delete entry.thinkingDefault;
        else if (thinking) entry.thinkingDefault = thinking;
      },
    });
    await store.setChoice(target.accountId, key, plan.applied);
  } catch (err) {
    logWarn(log, `[clawbits] agent default model not applied to ${target.agentId}: ${String((err as Error)?.message ?? err)}`);
  }
}

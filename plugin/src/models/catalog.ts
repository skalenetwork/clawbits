import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type PluginRuntime = OpenClawPluginApi["runtime"];
type ThinkingPolicy = ReturnType<PluginRuntime["agent"]["resolveThinkingPolicy"]>;

interface ModelOption {
  ref: string;
  provider: string;
  name: string;
  levels: string[];
  default_level: string | null;
}

interface ModelsReport {
  models: ModelOption[];
  default_model: string | null;
  default_thinking: string | null;
}

export function toRows(
  data: Pick<ModelsProviderData, "byProvider" | "modelNames">,
  policyFor: (provider: string, model: string) => ThinkingPolicy,
): ModelOption[] {
  return [...data.byProvider]
    .flatMap(([provider, models]) =>
      [...models]
        .filter((model) => !model.endsWith(":batch"))
        .map((model) => {
          const ref = `${provider}/${model}`;
          const policy = policyFor(provider, model);
          return {
            ref,
            provider,
            name: data.modelNames.get(ref) ?? model,
            levels: policy.levels.map((level) => level.id),
            default_level: policy.defaultLevel ?? null,
          };
        }),
    )
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

export async function readCatalog(
  runtime: PluginRuntime,
  agentId: string,
): Promise<ModelsReport | undefined> {
  const [agentRuntime, modelsRuntime]: [
    Partial<typeof import("openclaw/plugin-sdk/agent-runtime")>,
    Partial<typeof import("openclaw/plugin-sdk/models-provider-runtime")>,
  ] = await Promise.all([
    import("openclaw/plugin-sdk/agent-runtime").catch(() => ({})),
    import("openclaw/plugin-sdk/models-provider-runtime").catch(() => ({})),
  ]);
  const { loadPreparedModelCatalog, parseModelRef } = agentRuntime;
  const { buildPreparedModelsProviderData } = modelsRuntime;
  const { agent, config: runtimeConfig } = runtime;
  if (
    !loadPreparedModelCatalog ||
    !parseModelRef ||
    !buildPreparedModelsProviderData ||
    typeof agent?.resolveThinkingPolicy !== "function" ||
    typeof agent.defaults?.provider !== "string" ||
    typeof runtimeConfig?.current !== "function"
  ) {
    return undefined;
  }
  const config = runtimeConfig.current() as OpenClawConfig;
  await loadPreparedModelCatalog({ config, agentId, readOnly: true, refreshFullCatalog: true });
  const data = await buildPreparedModelsProviderData(config, agentId);
  const policyFor = (provider: string, model: string): ThinkingPolicy =>
    agent.resolveThinkingPolicy({ provider, model, catalog: data.modelCatalog });
  const defaults = config.agents?.defaults;
  const primary = typeof defaults?.model === "string" ? defaults.model : defaults?.model?.primary;
  const fallback = primary ? parseModelRef(primary, agent.defaults.provider) : null;
  return {
    models: toRows(data, policyFor),
    default_model: fallback && `${fallback.provider}/${fallback.model}`,
    default_thinking:
      fallback &&
      (defaults?.thinkingDefault ?? policyFor(fallback.provider, fallback.model).defaultLevel ?? null),
  };
}

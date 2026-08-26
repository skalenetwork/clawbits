import type { Static, TSchema } from "typebox";
import type { OpenClawConfig } from "./core.js";

export interface ToolPluginApi {
  config: OpenClawConfig;
  registerTool?: (tool: DefinedToolPluginTool) => void;
  [key: string]: unknown;
}

export interface ToolPluginExecutionContext {
  api: ToolPluginApi;
  signal?: AbortSignal;
  toolCallId: string;
  onUpdate?: (update: unknown) => void;
}

type ToolPluginConfig<TConfigSchema extends TSchema | undefined> =
  TConfigSchema extends TSchema ? Static<TConfigSchema> : Record<string, never>;

export interface DefinedToolPluginTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  optional: boolean;
  execute?: (
    params: unknown,
    config: unknown,
    context: ToolPluginExecutionContext,
  ) => unknown;
}

interface ToolPluginToolDefinition<TConfig, TParamsSchema extends TSchema> {
  name: string;
  label?: string;
  description: string;
  parameters: TParamsSchema;
  optional?: boolean;
  execute: (
    params: Static<TParamsSchema>,
    config: TConfig,
    context: ToolPluginExecutionContext,
  ) => unknown;
}

interface DefineToolPluginOptions<TConfigSchema extends TSchema | undefined> {
  id: string;
  name: string;
  description: string;
  configSchema?: TConfigSchema;
  tools: (
    tool: <TParamsSchema extends TSchema>(
      definition: ToolPluginToolDefinition<ToolPluginConfig<TConfigSchema>, TParamsSchema>,
    ) => DefinedToolPluginTool,
  ) => readonly DefinedToolPluginTool[];
}

export interface DefinedToolPluginEntry {
  id: string;
  name: string;
  description: string;
  configSchema: TSchema | undefined;
  register(api: ToolPluginApi): void;
}

export interface ToolPluginMetadata {
  id: string;
  name: string;
  description: string;
  tools: Array<{
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    optional: boolean;
  }>;
}

const metadata = new WeakMap<object, ToolPluginMetadata>();

export function defineToolPlugin<TConfigSchema extends TSchema | undefined = undefined>(
  definition: DefineToolPluginOptions<TConfigSchema>,
): DefinedToolPluginEntry {
  const tools = definition.tools((toolDefinition) => ({
    ...toolDefinition,
    label: toolDefinition.label ?? toolDefinition.name,
    optional: toolDefinition.optional ?? false,
    execute: toolDefinition.execute as DefinedToolPluginTool["execute"],
  }));
  const entry = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    configSchema: definition.configSchema,
    register(api: ToolPluginApi): void {
      for (const tool of tools) api.registerTool?.(tool);
    },
  };
  metadata.set(entry, {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    tools: tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      optional: tool.optional,
    })),
  });
  return entry;
}

export function getToolPluginMetadata(entry: unknown): ToolPluginMetadata | undefined {
  return entry !== null && typeof entry === "object" ? metadata.get(entry) : undefined;
}

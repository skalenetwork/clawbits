import type { Static, TSchema } from "typebox";
import type { OpenClawConfig } from "./core.js";

export interface StubAgentToolResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
}

export interface StubAgentTool<TParamsSchema extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TParamsSchema;
  execute: (
    toolCallId: string,
    params: Static<TParamsSchema>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ) => unknown;
}

export interface OpenClawPluginApi {
  registrationMode?: string;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  logger: { info?: (message: string) => void; warn?: (message: string) => void };
  runtime: {
    version: string;
    channel?: {
      runtimeContexts?: {
        register(params: {
          channelId: string;
          capability: string;
          context: unknown;
        }): { dispose(): void };
        get<T>(params: { channelId: string; capability: string }): T | undefined;
      };
      [key: string]: unknown;
    };
  };
  registerTool<TParamsSchema extends TSchema>(
    tool: StubAgentTool<TParamsSchema>,
    opts?: { optional?: boolean; name?: string },
  ): void;
  on?: (hook: string, handler: (...args: any[]) => unknown) => void;
  [key: string]: unknown;
}

interface PluginEntryDefinition {
  id: string;
  name: string;
  description: string;
  configSchema?: unknown;
  register(api: OpenClawPluginApi): void;
}

export function definePluginEntry<T extends PluginEntryDefinition>(definition: T): T {
  return definition;
}

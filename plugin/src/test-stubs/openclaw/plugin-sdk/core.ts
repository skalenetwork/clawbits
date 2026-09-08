export function defineChannelPluginEntry<
  T extends {
    plugin?: unknown;
    registerCliMetadata?: (api: Record<string, unknown>) => void;
    registerFull?: (api: Record<string, any>) => void;
  } & Record<string, unknown>,
>(entry: T) {
  return {
    ...entry,
    channelPlugin: entry.plugin,
    register(api: Record<string, any>) {
      entry.registerCliMetadata?.(api);
      if (api.registrationMode === "cli-metadata") return;
      if (entry.plugin) api.registerChannel?.({ plugin: entry.plugin });
      if (api.registrationMode === undefined || api.registrationMode === "full") {
        entry.registerFull?.(api);
      }
    },
  };
}

const EMPTY_OBJECT_SCHEMA = { type: "object", additionalProperties: false, properties: {} } as const;

function parseEmpty(value: unknown) {
  if (value === undefined) return { success: true, data: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { success: false, error: { issues: [{ path: [], message: "expected config object" }] } };
  }
  if (Object.keys(value).length > 0) {
    return { success: false, error: { issues: [{ path: [], message: "config must be empty" }] } };
  }
  return { success: true, data: value };
}

export function emptyPluginConfigSchema() {
  return { safeParse: parseEmpty, jsonSchema: EMPTY_OBJECT_SCHEMA };
}

export function emptyChannelConfigSchema() {
  return { schema: EMPTY_OBJECT_SCHEMA, runtime: { safeParse: parseEmpty } };
}

export type OpenClawConfig = { channels?: Record<string, unknown>; [key: string]: unknown };
export type ChannelAccountSnapshot = Record<string, unknown>;
export type ChannelConfigAdapter<T = unknown> = Record<string, unknown>;
export type ChannelGatewayAdapter<T = unknown> = Record<string, unknown>;
export type ChannelGatewayContext<T = unknown> = Record<string, unknown>;
export type ChannelMessagingAdapter = Record<string, unknown>;
export type ChannelOutboundAdapter = Record<string, unknown>;
export type ChannelOutboundContext = Record<string, unknown>;
export type ChannelPlugin<T = unknown> = Record<string, unknown>;
export type ChannelReplyDispatchContext = Record<string, unknown>;
export type ChannelSetupAdapter = Record<string, unknown>;
export type ChannelSetupConfigureContext = Record<string, unknown>;
export type ChannelSetupResult = Record<string, unknown>;
export type ChannelSetupStatusContext = Record<string, unknown>;
export type ChannelSetupStatus = Record<string, unknown>;
export type ChannelSetupWizardAdapter = Record<string, unknown>;
export type OutboundDeliveryResult = Record<string, unknown>;

/**
 * Local test-stub for the OpenClaw `openclaw/plugin-sdk/channel-contract`
 * subpath. Mirrors the loose-record style used by the sibling `core.ts`
 * stub: real runtime types come from the host at load time.
 *
 * Only the channel-action surfaces touched by `channel-actions.ts` are
 * declared here. Keep these widened to `Record<string, unknown>` (or
 * permissive aliases) so the plugin source compiles in isolation while
 * still being callable by the full host implementation at runtime.
 */
export type ChannelMessageActionName = string;

export type ChannelMessageActionAdapter = Record<string, unknown>;
export type ChannelMessageActionContext = {
  channel: string;
  action: string;
  cfg: { channels?: Record<string, unknown>; [key: string]: unknown };
  params: Record<string, unknown>;
  accountId?: string | null;
  toolContext?: Record<string, unknown>;
  [key: string]: unknown;
};
export type ChannelMessageActionDiscoveryContext = {
  cfg: { channels?: Record<string, unknown>; [key: string]: unknown };
  accountId?: string | null;
  [key: string]: unknown;
};
export type ChannelMessageToolDiscovery = {
  actions?: readonly string[] | null;
  capabilities?: readonly string[] | null;
  schema?: unknown;
  mediaSourceParams?: unknown;
};
export type ChannelMessageToolSchemaContribution = {
  properties: Record<string, unknown>;
  actions?: readonly string[] | null;
  visibility?: "current-channel" | "all-configured";
};
export type ChannelToolSend = {
  to: string;
  accountId?: string | null;
  threadId?: string | null;
};

/**
 * Generic agent-tool result shape. Mirrors the host's
 * `AgentToolResult<T>` loosely so handlers can return arbitrary JSON
 * payloads while staying type-checkable inside the plugin.
 */
export type AgentToolResult<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
  [key: string]: unknown;
};

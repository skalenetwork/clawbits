// Minimal stand-in for `openclaw/plugin-sdk/channel-message`. The real SDK
// export builds a `ChannelMessageAdapter` that the host's codex/agent bridge
// uses to deliver `tools.message` / `agent_message` output to channel plugins.
// Tests in this package do not exercise that bridge end-to-end, so the stub
// only needs to be callable and return a value the channel plugin can hand
// back to the host under its `message:` slot.

export interface CreateChannelMessageAdapterFromOutboundParams<TCfg = unknown> {
  id: string;
  live?: {
    capabilities?: Record<string, boolean>;
    finalizer?: {
      capabilities?: Record<string, boolean>;
    };
  };
  receive?: {
    defaultAckPolicy?: string;
    supportedAckPolicies?: readonly string[];
  };
  outbound: unknown;
  // Carry the config type through so callers can keep their generic for parity
  // with the real SDK signature; we never inspect it here.
  __cfg?: TCfg;
}

export function createChannelMessageAdapterFromOutbound<TCfg = unknown>(
  params: CreateChannelMessageAdapterFromOutboundParams<TCfg>,
): Record<string, unknown> {
  return {
    id: params.id,
    live: params.live,
    receive: params.receive,
    outbound: params.outbound,
  };
}

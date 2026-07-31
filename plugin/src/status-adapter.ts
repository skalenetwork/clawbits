import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
} from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { getClawBitsLatencySnapshot } from "./latency-metrics.js";
import type { ResolvedClawBitsAccount } from "./types.js";

export const statusAdapter: NonNullable<ChannelPlugin<ResolvedClawBitsAccount>["status"]> = {
  defaultRuntime: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  } as ChannelAccountSnapshot,
  buildChannelSummary: ({ snapshot }: { snapshot: ChannelAccountSnapshot }) => ({
    configured: snapshot.configured ?? false,
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
    endpoint: (snapshot as { endpoint?: string | null }).endpoint ?? null,
    channelId: (snapshot as { channelId?: string | null }).channelId ?? null,
  }),
  buildAccountSnapshot: ({
    account,
    runtime,
  }: {
    account: ResolvedClawBitsAccount;
    runtime?: ChannelAccountSnapshot;
  }) => ({
    accountId: account.accountId,
    ...(account.name ? { name: account.name } : {}),
    enabled: account.enabled,
    configured: account.configured,
    running: runtime?.running ?? false,
    lastStartAt: runtime?.lastStartAt ?? null,
    lastStopAt: runtime?.lastStopAt ?? null,
    lastError: runtime?.lastError ?? null,
    lastInboundAt: runtime?.lastInboundAt ?? null,
    lastOutboundAt: runtime?.lastOutboundAt ?? null,
    endpoint: account.endpoint ?? null,
    orgId: account.orgId ?? null,
    ownerEmail: account.ownerEmail ?? null,
    agentId: account.agentId ?? null,
    channelId: account.channelId ?? null,
    clawbitsLatency: getClawBitsLatencySnapshot(account.accountId),
  }),
};

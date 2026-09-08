import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  listClawBitsAccountIds,
  resolveDefaultClawBitsAccountId,
  resolveClawBitsAccount,
} from "./accounts.js";
import type { ResolvedClawBitsAccount } from "./types.js";

/** The SDK ships no named export for the config slot; take it from the plugin contract. */
type ChannelConfigAdapter<ResolvedAccount> = ChannelPlugin<ResolvedAccount>["config"];

export const configAdapter: ChannelConfigAdapter<ResolvedClawBitsAccount> = {
  listAccountIds: (cfg) => listClawBitsAccountIds(cfg),
  resolveAccount: (cfg, accountId) => resolveClawBitsAccount({ cfg, accountId }),
  defaultAccountId: (cfg) => resolveDefaultClawBitsAccountId(cfg),
  isConfigured: (account) => account.configured,
  unconfiguredReason: (account) => {
    const missing: string[] = [];
    if (!account.orgId && !account.ownerEmail) missing.push("orgId");
    if (!account.agentId) missing.push("agentId");
    if (!account.apiKey) missing.push("apiKey");
    if (!account.channelId) missing.push("channelId");
    return missing.length
      ? `Missing ${missing.join(", ")}. Run "openclaw configure" and pick Clawbits.`
      : "Clawbits account is not fully configured.";
  },
};

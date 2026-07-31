import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-message";
import { CHANNEL_ID } from "./accounts.js";
import { outboundAdapter } from "./outbound-adapter.js";

// ---------------------------------------------------------------------------
// message adapter - bridges the host's `message` tool / codex `agent_message`
// stream to our outbound. Without this slot, codex-harness replies (which are
// emitted as `tools.message({action:"send"})` from the agent's exec sandbox)
// have no channel-side consumer for Clawbits and silently drop, leaving the
// draft to finalize as "(reply failed to generate)". Other plugin channels
// (e.g. telegram) wire the same SDK helper.
// ---------------------------------------------------------------------------

export const messageAdapter = createChannelMessageAdapterFromOutbound<OpenClawConfig>({
  id: CHANNEL_ID,
  live: {
    // We open a draft post at turn start (`createDraftPost`) and finalize it
    // with a single PATCH (`patchDraftPost { replace, done: true }`). We do
    // not stream incremental updates today, so `progressUpdates` stays off.
    capabilities: {
      draftPreview: true,
      previewFinalization: true,
      progressUpdates: false,
    },
    finalizer: {
      capabilities: {
        finalEdit: true,
        normalFallback: true,
        previewReceipt: true,
        retainOnAmbiguousFailure: true,
      },
    },
  },
  receive: {
    defaultAckPolicy: "after_agent_dispatch",
    supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
  },
  outbound: outboundAdapter,
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { CHANNEL_ID } from "./accounts.js";
import { outboundAdapter } from "./outbound-adapter.js";

const adapter = createChannelMessageAdapterFromOutbound<OpenClawConfig>({
  id: CHANNEL_ID,
  outbound: outboundAdapter,
  capabilities: { text: true, media: true, payload: true, reconcileUnknownSend: true },
  live: {
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
});

/** Every send carries its durable intent as an idempotency key, so replaying an ambiguous one cannot post twice. */
export const messageAdapter: typeof adapter = {
  ...adapter,
  durableFinal: {
    ...adapter.durableFinal,
    automaticUnknownSendReconciliation: true,
    reconcileUnknownSendKinds: { text: true, media: true, payload: true },
    reconcileUnknownSend: () => ({ status: "not_sent" }),
  },
};

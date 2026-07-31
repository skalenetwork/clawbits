import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { CHANNEL_ID } from "./accounts.js";
import { createClawBitsActions } from "./channel-actions.js";
import { __attachmentsTest } from "./attachments.js";
import { configAdapter } from "./config-adapter.js";
import { gatewayAdapter } from "./gateway-adapter.js";
import { messageAdapter } from "./message-adapter.js";
import { messagingAdapter } from "./messaging-adapter.js";
import { outboundAdapter } from "./outbound-adapter.js";
import { setupAdapter, setupWizard } from "./setup-adapter.js";
import { statusAdapter } from "./status-adapter.js";
import type { ResolvedClawBitsAccount } from "./types.js";

// Re-exported so existing consumers (and the unit tests) can keep importing
// these from `./plugin.js` after the module split.
export { buildAgentBody, clawbitsSessionId } from "./agent-body.js";
export {
  CLAWBITS_CHANNEL_ID_RE,
  looksLikeClawBitsId,
  messagingAdapter,
  normalizeClawBitsTarget,
} from "./messaging-adapter.js";
export {
  dispatchInboundMessage,
  tagReplyBody,
  type DispatchInboundDeps,
} from "./gateway-adapter.js";

// ---------------------------------------------------------------------------
// the plugin
// ---------------------------------------------------------------------------

export const clawbitsChannelPlugin: ChannelPlugin<ResolvedClawBitsAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Clawbits",
    selectionLabel: "Clawbits (Human Channel)",
    detailLabel: "Clawbits",
    docsPath: "/channels/clawbits",
    docsLabel: "clawbits",
    blurb: "Bridge an OpenClaw agent to its organization over Clawbits.",
    systemImage: "person.wave.2",
    order: 500,
    markdownCapable: false,
    exposure: { configured: true, setup: true, docs: true },
  },
  capabilities: {
    // Both DMs and shared channels are supported. ``"channel"`` is required
    // here or core's outbound router won't route a ``channel``-typed reply
    // back through this plugin: the inbound dispatcher tags non-DM posts as
    // ``ChatType: "channel"`` (see gateway-adapter), and core gates outbound
    // session resolution on this list (infra/outbound/outbound-session.ts).
    // With only ``"direct"`` declared, DMs deliver but channel replies are
    // silently dropped (codex `tools.message` sends never reach
    // outbound.sendText).
    chatTypes: ["direct", "channel"],
    reactions: true,
    // Outbound attachments are live: core routes media-bearing replies to
    // ``outbound.sendMedia`` (upload → post with ``file_ids``). Inbound
    // attachments were already handled by the poller + attachments module.
    media: true,
    threads: false,
    polls: false,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: configAdapter,
  setup: setupAdapter,
  setupWizard,
  outbound: outboundAdapter,
  // `messaging` lets the host validate / normalize / resolve targets the
  // codex bridge passes to the message tool (bare channel UUIDs, the
  // `default` sentinel, peer-prefixed `to` from session deliveryContext).
  // Without it, target validation rejects everything and the reply never
  // reaches outbound.sendText — see messagingAdapter above.
  messaging: messagingAdapter,
  // `message` is the slot the host's codex/agent bridge feeds `tools.message`
  // / `agent_message` output into. Without it the bridge has no Clawbits-side
  // consumer and the reply is dropped silently — see messageAdapter above.
  message: messageAdapter,
  status: statusAdapter,
  gateway: gatewayAdapter,
  // Channel-owned action surface for the shared `message` tool. Currently
  // wires `react` and `reactions` only; text sends still flow through
  // `outboundAdapter.sendText`. Adding more actions (edit, delete, etc.)
  // means extending `channel-actions.ts` and growing CLAWBITS_ACTIONS.
  actions: createClawBitsActions(),
};

/** Internal: exported only so unit tests can drive private helpers without
 *  routing through the full inbound dispatch pipeline. */
export const __test = __attachmentsTest;

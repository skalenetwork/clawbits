import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { CHANNEL_ID, resolveClawBitsAccount } from "./accounts.js";

// ---------------------------------------------------------------------------
// messaging adapter - target validation + resolution for the shared message
// tool. Without these hooks the host's target validator rejects both bare
// channel UUIDs and the plugin's `default` route, so the agent's codex
// `tools.message({action:"send"})` call never reaches outbound.sendText.
// ---------------------------------------------------------------------------

/** Mattermost channel ids are RFC-4122 v4 UUIDs (8-4-4-4-12 hex). */
export const CLAWBITS_CHANNEL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Treat as a routable Clawbits identifier: UUID-shaped channel id or the
 *  `default` sentinel that resolves to the configured channel for the
 *  account. Anything else is left for `resolveTarget` to decide. */
export function looksLikeClawBitsId(raw: string, normalized?: string): boolean {
  const v = (normalized ?? raw).trim();
  if (!v) return false;
  if (v.toLowerCase() === "default") return true;
  return CLAWBITS_CHANNEL_ID_RE.test(v);
}

/** Strip the optional `clawbits:` provider prefix so downstream comparison and
 *  validation see a bare identifier. Returns `undefined` for empty input so
 *  the host's normalizer can fall back to its own defaults. */
export function normalizeClawBitsTarget(raw: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^clawbits:/i, "");
}

export const messagingAdapter: ChannelMessagingAdapter = {
  // Accept explicit cross-channel targets like `clawbits:<channelId>` and
  // route them through this plugin instead of bouncing them as "unknown".
  targetPrefixes: [CHANNEL_ID],
  normalizeTarget: normalizeClawBitsTarget,
  targetResolver: {
    looksLikeId: looksLikeClawBitsId,
    hint: "<channelId | default>",
    /**
     * Resolve any target the validator hands us into a concrete Mattermost
     * channel id. Three cases the codex bridge actually hits:
     *
     *   - `default` (or empty) → the configured `channelId` for this account.
     *     This is what the message tool falls back to when the agent calls
     *     `tools.message({action:"send"})` with no explicit target.
     *   - bare UUID → already a channel id, take it as-is.
     *   - peer-prefixed (e.g. `clawbits:human:3` from the session's
     *     `deliveryContext.to`) or any other shape → fall back to the
     *     configured channel. Clawbits accounts are 1-channel-per-account
     *     (the owner DM), so non-id targets always resolve to that channel.
     *
     * Without the last branch the codex harness's `to` value (the sender
     * peer address) fails validation and the reply is dropped.
     */
    resolveTarget: async ({ cfg, accountId, input, normalized }) => {
      const target = (normalized || input || "").trim();
      const account = resolveClawBitsAccount({
        cfg,
        ...(accountId ? { accountId } : {}),
      });
      const fallbackChannel = account.channelId;

      if (!target || target.toLowerCase() === "default") {
        if (!fallbackChannel) return null;
        return { to: fallbackChannel, kind: "channel", source: "normalized" };
      }
      if (CLAWBITS_CHANNEL_ID_RE.test(target)) {
        return { to: target, kind: "channel", source: "normalized" };
      }
      // A ``channel:<id>`` peer (the route peer for a shared-channel reply,
      // passed through when the session deliveryContext carries the kind
      // prefix) names a real channel — resolve to that id, NOT the fallback.
      // Without this, a channel reply would be rewritten to the owner DM.
      // DM peers (``user:``/``human:``) intentionally fall through to the
      // fallback below, since a 1-channel-per-account DM IS the owner channel.
      const channelPeer = /^channel:(.+)$/i.exec(target);
      if (channelPeer) {
        const peerId = channelPeer[1].trim();
        if (CLAWBITS_CHANNEL_ID_RE.test(peerId)) {
          return { to: peerId, kind: "channel", source: "normalized" };
        }
      }
      if (fallbackChannel) {
        return { to: fallbackChannel, kind: "channel", source: "normalized" };
      }
      return null;
    },
  },
};

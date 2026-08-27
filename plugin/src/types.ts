export interface ChallengeAnswer {
  sessionToken: string;
  response: string;
}

export interface Challenge {
  session_token: string;
  challenge: string;
}

export interface SignupResponse {
  session_token: string;
  challenge: string;
  [key: string]: unknown;
}

export interface AgentCreated {
  agent_id: string;
  api_key: string;
  status?: "approved" | "pending_approval" | string;
  signup_request_id?: string;
  approval_url?: string;
  claim_url?: string;
  [key: string]: unknown;
}

export interface ChannelCreate {
  name: string;
  display_name: string;
  channel_type: string;
  [key: string]: unknown;
}

export interface ChannelPost {
  message: string;
  /** Pre-uploaded attachment ids to bind to this post (see tools/mattermost
   *  `directFileUpload` / `requestFileUpload`). Server cap: 5 per post. */
  file_ids?: string[];
  [key: string]: unknown;
}

/**
 * Clawbits per-account channel config as it lives under
 * `channels.clawbits.accounts.<accountId>.*` in the host OpenClawConfig.
 * The top-level `channels.clawbits.*` section is also merged in so a
 * single-account setup can keep config flat (matching the OpenClaw
 * channel-plugin convention).
 */
export interface ClawBitsAccountConfig {
  name?: string;
  enabled?: boolean;
  endpoint?: string;
  /** Organization ID this agent belongs to. New setup uses orgId; ownerEmail is legacy. */
  orgId?: string;
  ownerEmail?: string;
  agentId?: string;
  apiKey?: string;
  channelId?: string;
  knownAnswers?: Record<string, string>;
  /** Optional inbound sender allowlist. Empty / missing means allow everyone.
   *  Use `human:<id>` or `agent:<id>`; bare values are accepted as aliases. */
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  /**
   * Inter-agent mode. When true, the gateway may dispatch messages authored by
   * other agents and replies are tagged to the sender. Defaults false so the
   * agent processes human-authored requests only. The server-side per-agent
   * setting, when present on the channel-list response, overrides this local
   * fallback at runtime.
   */
  interAgentMode?: boolean;
  /** Max consecutive agent-authored turns before pausing for human guidance. */
  interAgentMessageLimit?: number;
  /** Milliseconds between fallback polls when realtime is unavailable. */
  pollIntervalMs?: number;
  /** Prefer one agent WebSocket over per-channel SSE. Defaults true. */
  websocketEnabled?: boolean;
  /** Milliseconds between rare reconciliation polls while WebSocket is healthy. */
  websocketReconcileIntervalMs?: number;
  /** Milliseconds between channel/settings refreshes while WebSocket is healthy. */
  websocketControlRefreshIntervalMs?: number;
  /** Milliseconds an inbound post may wait in the local dispatch queue before it is dropped. */
  inboundQueueTtlMs?: number;
  /**
   * Run the one-shot catch-up pass at gateway start, so messages that arrived
   * while the agent was down (a reef restart, an image upgrade, a crash) are
   * answered instead of silently skipped. Default ``true``.
   */
  catchUpEnabled?: boolean;
  /**
   * Pre-open the streaming "shimmer" draft for inbound posts in group /
   * public / private channels (not just DMs). Default ``true`` — set to
   * ``false`` if the host runtime double-posts in non-direct channels,
   * which would surface as the finalised draft *plus* a duplicate message
   * from the runtime's own outbound.
   */
  groupChannelShimmer?: boolean;
  /**
   * How many recent posts to hand the agent as read-only context each time it
   * is tagged in a non-direct channel — the messages that arrived since it
   * last looked, so it can catch up on what it missed. A persisted per-channel
   * watermark dedupes, so the same post is never surfaced twice (across
   * mentions or restarts). ``0`` disables the feature. Defaults to ``100``.
   * Applies to shared (non-direct, non-operator) channels; DMs are unaffected
   * (the agent already sees every DM). Independent of the agent's
   * ``require_response_approval`` flag — that governs the inbound approval
   * workflow, not context ingestion.
   */
  channelContextBacklog?: number;
  /**
   * Liveness ping cadence. The plugin POSTs `/api/agentic/alive` on startup and
   * then every `alive.every` SECONDS, so Clawbits shows the agent as
   * "Available" (it flips to "Offline" ~40 min after the last ping, and shows
   * "Setup" until the first one). This is the plugin's own timer —
   * deliberately independent of OpenClaw's LLM heartbeat. Default 600 (10 min),
   * clamped to a 60s floor. Set `alive.every: 0` or `alive.enabled: false` to
   * disable the pinger.
   */
  alive?: { enabled?: boolean; every?: number };
  /**
   * Email integration. When the agent's mailbox is provisioned server-side,
   * the gateway runs a lightweight poller that injects incoming email into the
   * owner's session and lets the agent reply / send over email. Defaults on;
   * only an explicit ``false`` disables it. The poller self-disables anyway if
   * the server reports email is not configured (503), so leaving it on is safe.
   */
  emailEnabled?: boolean;
  /** Milliseconds between email mailbox polls. Default 60000, floored at 30000. */
  emailPollIntervalMs?: number;
  /**
   * Live token-streaming of replies: assistant deltas from the gateway's
   * agent-event plane are PATCHed into the open draft as they generate, so
   * the channel shows the reply growing instead of a shimmer-then-pop.
   * Cosmetic-only (the final deliver PATCH stays authoritative). Default
   * ``true``; set ``false`` to fall back to shimmer-then-final.
   */
  streaming?: boolean;
  /**
   * Live activity line: sanitized thinking snippets and tool-usage labels
   * are reported on the channel status lane while a turn runs ("Using
   * web_search: '…'"). Ephemeral (presence-TTL'd server-side, never
   * persisted). Default ``true``. See LIVE_AGENT_ACTIVITY_PLAN.md.
   */
  liveActivity?: boolean;
}

export interface ClawBitsChannelSection extends ClawBitsAccountConfig {
  accounts?: Record<string, Partial<ClawBitsAccountConfig>>;
  defaultAccount?: string;
  /** Migration owner for non-channel background services. Missing defaults to the legacy channel owner. */
  serviceOwner?: "channel" | "tools";
}

export interface ResolvedClawBitsAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  endpoint: string;
  orgId?: string;
  ownerEmail?: string;
  agentId?: string;
  apiKey?: string;
  channelId?: string;
  knownAnswers: Record<string, string>;
  /** Normalized inbound sender allowlist. Empty means allow everyone.
   *  See ``ClawBitsAccountConfig.allowFrom``. */
  allowFrom: string[];
  /** Defaults false; see ``ClawBitsAccountConfig.interAgentMode``. */
  interAgentMode: boolean;
  /** Defaults 10, max 50; see ``ClawBitsAccountConfig.interAgentMessageLimit``. */
  interAgentMessageLimit: number;
  /** Defaults to ``true``; see ``ClawBitsAccountConfig.groupChannelShimmer``. */
  groupChannelShimmer: boolean;
  /** Resolved, non-negative integer; defaults to ``100``. ``0`` disables.
   *  See ``ClawBitsAccountConfig.channelContextBacklog``. */
  channelContextBacklog: number;
  /** Resolved liveness ping interval in milliseconds; `0` disables the pinger.
   *  See `ClawBitsAccountConfig.alive`. */
  alivePingMs: number;
  /** Defaults to ``true``; see ``ClawBitsAccountConfig.emailEnabled``. */
  emailEnabled: boolean;
  /** Resolved email poll interval in milliseconds; floored at 30000.
   *  See ``ClawBitsAccountConfig.emailPollIntervalMs``. */
  emailPollIntervalMs: number;
  /** Defaults to ``true``; see ``ClawBitsAccountConfig.streaming``. */
  streaming: boolean;
  /** Defaults to ``true``; see ``ClawBitsAccountConfig.liveActivity``. */
  liveActivity: boolean;
  /** The merged per-account config slice that was resolved. */
  config: ClawBitsAccountConfig;
}

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { registerClawBitsCli } from "./cli.js";
import { clawbitsChannelPlugin } from "./plugin.js";
import { registerActivitySubscription } from "./activity/subscription.js";
import { setCronHandle, type CronHandle } from "./automations/cron-handle.js";
import { wakeAutomationsReconciler } from "./automations/reconcile.js";
import { registerUsageHooks } from "./usage/collector.js";

/** The hook surface we use from the gateway runtime. The vendored SDK stub
 *  types these loosely, so cast to exactly what we call. `ctx.getCron()` returns
 *  the real in-process CronService (fuller than its public type) — see
 *  automations/cron-handle.ts. The cron hooks are infra (not
 *  conversation-content), so this global-origin plugin registers them with no
 *  extra grant; the usage hooks add `reply_payload_sending` (ungated) and
 *  `llm_output` (conversation-class — the gateway blocks it with a warn
 *  diagnostic unless the operator config grants
 *  `plugins.entries.clawbits.hooks.allowConversationAccess=true`). */
interface GatewayHookApi {
  on?: (
    hook: string,
    handler: (event: unknown, ctx?: { getCron?: () => CronHandle | undefined }) => void,
  ) => void;
}

export default defineChannelPluginEntry({
  id: "clawbits",
  name: "Clawbits Human Channel",
  description:
    "Bridge an OpenClaw agent to its Clawbits organization. For agents: run `openclaw clawbits signup --endpoint <url> --org-id <id> --signup-token <token>` for a non-interactive signup. The token comes from the Clawbits Add agent prompt. The command mints tokens, resolves the owner channel, and prints exact config commands. To self-update when instructed to update the Clawbits plugin, run `openclaw clawbits update` — it prints the exact upgrade command for this install: for a remote install, `openclaw plugins install clawhub:clawbits-openclaw-plugin --pin --force --acknowledge-clawhub-risk` (fetches the newest compatible release and stays pinned); for a local checkout, a rebuild + force-reinstall recipe. Run the printed command; it auto-restarts the managed Gateway, so treat it as a terminal action and re-announce once the channel reconnects. To report which plugin version you are running (and whether it is current), run `openclaw clawbits version` (add `--check` to compare against the server's minimum). Use `--json` for automation/debug output. Config lives under channels.clawbits.accounts.*. Bundled Clawbits documentation ships with this package under `clawbits-openclaw-plugin/docs/`.",
  plugin: clawbitsChannelPlugin,
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  registerCliMetadata: registerClawBitsCli,
  // gateway_start hands us the in-process cron handle (the reconciler's write
  // path — no token/pairing/scope needed); cron_changed wakes the reconciler so
  // the mirror reflects local changes (including jobs made via `openclaw cron`).
  registerFull: (api) => {
    const hookApi = api as unknown as GatewayHookApi;
    hookApi.on?.("gateway_start", (_event, ctx) => {
      try {
        setCronHandle(ctx?.getCron?.());
      } catch {
        /* best-effort: leave the reconciler idle if cron access is unavailable */
      }
    });
    hookApi.on?.("cron_changed", () => {
      wakeAutomationsReconciler();
    });
    // AI-usage collector: passive observers on the reply-dispatch and (where
    // granted) llm_output planes; the per-account usage reporter loop drains
    // what these queue. See docs/protocol/AGENT_USAGE_TRACKING_PLAN.md.
    registerUsageHooks(hookApi);
    // Live activity: subscribe to the (ungated) agent-event plane —
    // lifecycle/assistant/thinking/tool — feeding the streaming text lane
    // and the ephemeral activity lane. Observer-only; degrades to the
    // shimmer-then-final UX on hosts without the API. See
    // docs/protocol/LIVE_AGENT_ACTIVITY_PLAN.md.
    registerActivitySubscription(api);
  },
});

export { clawbitsChannelPlugin } from "./plugin.js";
export type {
  ClawBitsAccountConfig,
  ClawBitsChannelSection,
  ResolvedClawBitsAccount,
} from "./types.js";

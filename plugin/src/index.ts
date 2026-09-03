import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { registerClawBitsCli } from "./cli.js";
import { clawbitsChannelPlugin } from "./plugin.js";
import { registerActivitySubscription } from "./activity/subscription.js";
import {
  registerSlimChannelHandoff,
  resolveClawBitsServiceOwner,
} from "./service-handoff.js";
import { PLUGIN_VERSION } from "./version.js";

export default defineChannelPluginEntry({
  id: "clawbits",
  name: "Clawbits Human Channel",
  description:
    "Bridge an OpenClaw agent to its Clawbits organization. For agents: run `openclaw clawbits signup --endpoint <url> --org-id <id> --signup-token <token>` for a non-interactive signup. The token comes from the Clawbits Add agent prompt. The command mints tokens, resolves the owner channel, and prints exact config commands. To self-update when instructed to update the Clawbits plugin, first follow `docs/SPLIT_MIGRATION.md` when moving from a version before 0.17; it installs the companion before the slim channel. Otherwise run `openclaw clawbits update` — it prints the exact upgrade command for this install: for a remote install, `openclaw plugins install clawhub:clawbits-openclaw-plugin --force --accept-capabilities` (fetches the newest compatible release), or the `--pin --force` form on a gateway older than OpenClaw 2026.8; for a local checkout, a rebuild + force-reinstall recipe. Run the printed command; it auto-restarts the managed Gateway, so treat it as a terminal action and re-announce once the channel reconnects. To report which plugin version you are running (and whether it is current), run `openclaw clawbits version` (add `--check` to compare against the server's minimum). Use `--json` for automation/debug output. Config lives under channels.clawbits.accounts.*. Bundled Clawbits documentation ships with this package under `clawbits-openclaw-plugin/docs/`.",
  plugin: clawbitsChannelPlugin,
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  registerCliMetadata: registerClawBitsCli,
  registerFull: (api) => {
    const hostApi = api as typeof api & {
      config?: OpenClawConfig;
      logger?: { warn?: (message: string) => void };
    };
    if (hostApi.config) {
      const owner = resolveClawBitsServiceOwner(hostApi.config);
      if (!owner.valid) {
        hostApi.logger?.warn?.(
          "[clawbits] invalid serviceOwner; background services remain disabled until it is 'tools'",
        );
      } else if (owner.owner !== "tools") {
        hostApi.logger?.warn?.(
          "[clawbits] slim channel active with serviceOwner=channel; install clawbits-openclaw-tools and set channels.clawbits.serviceOwner=tools to restore cron, email, usage, and skills services",
        );
      }
    }

    // Public runtime-context marker consumed by the companion plugin. An old
    // channel has no marker, so a newly installed companion remains idle and
    // cannot duplicate the old channel-owned background services.
    const handoff = registerSlimChannelHandoff(api.runtime, PLUGIN_VERSION);
    api.on?.("gateway_stop", () => handoff?.dispose());

    // Live activity belongs to the channel: lifecycle/assistant/thinking/tool
    // events feed the streaming reply and ephemeral channel status lanes.
    registerActivitySubscription(api);
  },
});

export { clawbitsChannelPlugin } from "./plugin.js";
export type {
  ClawBitsAccountConfig,
  ClawBitsChannelSection,
  ResolvedClawBitsAccount,
} from "./types.js";

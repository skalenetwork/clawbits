/** Prompt builders + URL/env constants for the "Add agent" wizard (non-
 *  component module so the component files stay fast-refresh friendly). The
 *  prompt builders and URL derivation moved verbatim from the pre-wizard
 *  dialog. */
import {type Org} from "@/lib/api";

export const PLUGIN_SLUG = "clawhub:clawbits-openclaw-plugin";

/** POSIX env-var name; mirrors reef's server-side rule (which stays the
 *  source of truth — reserved keys etc. come back as a readable 422). */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function deriveSelfHostClawbitsUrl(): string {
    const baked = (import.meta.env.VITE_CLAWBITS_API_URL as string | undefined)?.trim();
    return baked && baked.length > 0 ? baked : window.location.origin;
}

function setupContext(org: Org | null) {
    const apiBase = deriveSelfHostClawbitsUrl();
    const orgId = org?.org_id ?? "(unknown)";
    const display = org?.display_name?.trim();
    const orgLabel = display && display.length > 0 ? display : (org?.name ?? "your organization");
    return {apiBase, orgId, orgLabel};
}

export function buildOpenClawSetupPrompt(org: Org | null, signupToken: string): string {
    const {apiBase, orgId, orgLabel} = setupContext(org);
    return [
        `You are being onboarded to ${orgLabel} on Clawbits (${apiBase}).`,
        "Run these steps non-interactively. Do not invoke `openclaw configure` — it is interactive and will hang.",
        "",
        "# 1. Install the plugin from the ClawHub registry (--acknowledge-clawhub-risk",
        "#    accepts ClawHub's first-party risk notice so the install is non-interactive):",
        `openclaw plugins install ${PLUGIN_SLUG} --pin --acknowledge-clawhub-risk`,
        "",
        "# 2. Sign up with this one-time token. No approval step is needed.",
        `openclaw clawbits signup --endpoint ${apiBase} --org-id ${orgId} --signup-token ${signupToken}`,
        "",
        "# 3. The command will mint tokens, resolve the Clawbits channel, and print exact",
        "#    `openclaw config set` commands. Run those printed commands exactly.",
        "",
        "# 4. Verify the channel is wired up:",
        "openclaw clawbits healthcheck",
    ].join("\n");
}

export function buildIronClawSetupPrompt(org: Org | null, signupToken: string): string {
    const {apiBase, orgId, orgLabel} = setupContext(org);
    return [
        `You are being onboarded to ${orgLabel} on Clawbits (${apiBase}).`,
        "Install the Clawbits WASM channel into this IronClaw agent. Run non-interactively; do not open `ironclaw onboard`.",
        "",
        "# 1. Find the built ironclaw-channel directory (it must contain clawbits-ironclaw and clawbits.wasm).",
        "CHANNEL_DIR=\"${CLAWBITS_IRONCLAW_CHANNEL_DIR:-}\"",
        "if [ -z \"$CHANNEL_DIR\" ]; then",
        "  found=$(find \"$HOME\" -maxdepth 5 -type f -path '*/ironclaw-channel/clawbits-ironclaw' -print -quit 2>/dev/null || true)",
        "  CHANNEL_DIR=${found%/clawbits-ironclaw}",
        "fi",
        "if [ -z \"$CHANNEL_DIR\" ]; then",
        "  echo 'Could not find ironclaw-channel/clawbits-ironclaw. Ask the operator for the local Clawbits repo path, then rerun from ironclaw-channel/.'",
        "  exit 1",
        "fi",
        "cd \"$CHANNEL_DIR\"",
        "",
        "# 2. Exchange this one-time token for a NEW agent API key and reinstall the channel.",
        "#    --new-agent overwrites any existing Clawbits key/config and clears local Clawbits install state.",
        `./clawbits-ironclaw reinstall --no-build --new-agent --endpoint ${JSON.stringify(apiBase)} --org-id ${JSON.stringify(orgId)} --signup-token ${JSON.stringify(signupToken)}`,
        "",
        "# 3. Restart full IronClaw so it loads the channel (not ironclaw-reborn).",
        "ironclaw run",
        "# If running from source instead:",
        "#   cd /path/to/ironclaw && cargo run -q --bin ironclaw -- run",
    ].join("\n");
}

export function buildHermesSetupPrompt(org: Org | null, signupToken: string): string {
    const {apiBase, orgId, orgLabel} = setupContext(org);
    return [
        `You are being onboarded to ${orgLabel} on Clawbits (${apiBase}).`,
        "Install the Clawbits platform plugin into this Hermes agent. Run non-interactively.",
        "",
        "# 1. Find the Clawbits repo (it must contain extensions/hermes/reinstall.sh).",
        "REPO=\"${CLAWBITS_REPO_DIR:-}\"",
        "if [ -z \"$REPO\" ]; then",
        "  found=$(find \"$HOME\" -maxdepth 5 -type f -path '*/extensions/hermes/reinstall.sh' -print -quit 2>/dev/null || true)",
        "  REPO=${found%/extensions/hermes/reinstall.sh}",
        "fi",
        "if [ -z \"$REPO\" ]; then",
        "  echo 'Could not find extensions/hermes/reinstall.sh. Ask the operator for the local Clawbits repo path, then rerun from there.'",
        "  exit 1",
        "fi",
        "cd \"$REPO\"",
        "",
        "# 2. Clean (re)install the plugin into ~/.hermes/plugins, enable it, and exchange",
        "#    this one-time token for a NEW agent API key. -y skips the delete confirmation;",
        "#    this wipes any previous install and stale CLAWBITS_* config.",
        `./extensions/hermes/reinstall.sh -y --endpoint ${JSON.stringify(apiBase)} --org-id ${JSON.stringify(orgId)} --signup-token ${JSON.stringify(signupToken)}`,
        "",
        "# 3. The script writes ~/.hermes/.env and starts the gateway. If it printed the",
        "#    signup command instead of running it, run that command, then:",
        "hermes gateway start",
    ].join("\n");
}

/** Where a Reef-spun agent (a container/VM) should reach THIS clawbits. In prod
 *  the app + API share an origin; in local dev the agent is a Docker guest, so
 *  `localhost` is itself — it must use the runtime's host alias to reach the
 *  backend on the host (see docs/REEF.md §6; reef normalizes the alias to its
 *  own runtime's spelling). */
export function deriveClawbitsUrl(): string {
    const baked = (import.meta.env.VITE_CLAWBITS_API_URL as string | undefined)?.trim();
    const base = baked && baked.length > 0 ? baked : window.location.origin;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base)) {
        return "http://host.docker.internal:8000";
    }
    return base;
}

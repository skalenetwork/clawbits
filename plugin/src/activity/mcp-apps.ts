import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { listClawBitsAccountIds, resolveClawBitsAccount } from "../accounts.js";
import { logWarn } from "../file-logger.js";
import type { McpApp } from "../tools/realtime.js";

type Runtime = OpenClawPluginApi["runtime"];
type Logger = OpenClawPluginApi["logger"];

const VIEW_TIMEOUT_MS = 10_000;

/** Clawbits' own MCP server name and App resource prefix. */
const OWN_SERVER = "clawbits";
const OWN_RESOURCE_PREFIX = "ui://clawbits/";

/** OpenClaw's handle on the App view a tool result rendered, held in the gateway for ten minutes. */
export interface McpAppView {
  viewId: string;
  sessionKey: string;
  server: string;
  /** The App's `ui://` resource, when OpenClaw names it. */
  resource?: string;
}

interface McpAppPreview {
  mcpApp?: { viewId?: unknown; originSessionKey?: unknown; serverName?: unknown; uiResourceUri?: unknown };
}

interface McpAppViewResponse {
  html: string;
  csp?: McpApp["csp"];
  toolInput: McpApp["input"];
  toolResult: McpApp["result"];
}

let runtime: Runtime | undefined;
let logger: Logger | undefined;

/** Turns on OpenClaw's MCP Apps host unless the operator set it either way; the gateway restarts once to apply it. */
export function registerMcpApps(api: OpenClawPluginApi): void {
  runtime = api.runtime;
  logger = api.logger;
  api.on?.("gateway_start", async () => {
    if (api.runtime.config.current().mcp?.apps?.enabled !== undefined) return;
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        (draft.mcp ??= {}).apps = { ...draft.mcp.apps, enabled: true };
      },
    });
  });
}

export function mcpAppView(result: unknown): McpAppView | undefined {
  const app = (result as { details?: { mcpAppPreview?: McpAppPreview } } | undefined)?.details?.mcpAppPreview?.mcpApp;
  const { viewId, originSessionKey, serverName, uiResourceUri } = app ?? {};
  return typeof viewId === "string" && typeof originSessionKey === "string" && typeof serverName === "string"
    ? {
        viewId,
        sessionKey: originSessionKey,
        server: serverName,
        ...(typeof uiResourceUri === "string" ? { resource: uiResourceUri } : {}),
      }
    : undefined;
}

function originOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
}

/** A view clawbits' own MCP server rendered: by name, `ui://clawbits/` resource, or a server URL on a
 *  configured account endpoint's origin. It may show one seat's private game state, and a reply's steps
 *  reach every chat member, so it is never captured. */
export function isOwnMcpApp({ server, resource }: McpAppView): boolean {
  if (server.toLowerCase() === OWN_SERVER || resource?.toLowerCase().startsWith(OWN_RESOURCE_PREFIX)) return true;
  const cfg = runtime?.config.current() as OpenClawConfig | undefined;
  const origin = originOf(cfg?.mcp?.servers?.[server]?.url);
  if (!cfg || !origin) return false;
  return listClawBitsAccountIds(cfg).some(
    (accountId) => originOf(resolveClawBitsAccount({ cfg, accountId }).endpoint) === origin,
  );
}

/** The view's document and call, read while the gateway still holds it; undefined when it no longer does.
 *  Asked as a gateway client, because `runtime.gateway.request` serves only bundled and trusted official plugins. */
export async function fetchMcpApp({ viewId, sessionKey, server }: McpAppView): Promise<McpApp | undefined> {
  if (!runtime) return undefined;
  try {
    const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
    const view = (await callGatewayFromCli(
      "mcp.app.view",
      { timeout: String(VIEW_TIMEOUT_MS) },
      { sessionKey, viewId },
      { progress: false },
    )) as unknown as McpAppViewResponse;
    const url = runtime.config.current().mcp?.servers?.[server]?.url;
    return {
      server,
      ...(url ? { host: new URL(url).host } : {}),
      html: view.html,
      ...(view.csp ? { csp: view.csp } : {}),
      input: view.toolInput,
      result: view.toolResult,
    };
  } catch (err) {
    logWarn(logger, `[clawbits] mcp app view ${viewId} from ${server} unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

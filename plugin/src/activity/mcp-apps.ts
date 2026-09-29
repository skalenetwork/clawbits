import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { pluginDebug } from "../file-logger.js";
import type { McpApp } from "../tools/realtime.js";

type Runtime = OpenClawPluginApi["runtime"];

const VIEW_TIMEOUT_MS = 10_000;

/** OpenClaw's handle on the App view a tool result rendered, held in the gateway for ten minutes. */
export interface McpAppView {
  viewId: string;
  sessionKey: string;
  server: string;
}

interface McpAppPreview {
  mcpApp?: { viewId?: unknown; originSessionKey?: unknown; serverName?: unknown };
}

interface McpAppViewResponse {
  html: string;
  csp?: McpApp["csp"];
  toolInput: McpApp["input"];
  toolResult: McpApp["result"];
}

let runtime: Runtime | undefined;

/** Turns on OpenClaw's MCP Apps host unless the operator set it either way; the gateway restarts once to apply it. */
export function registerMcpApps(api: OpenClawPluginApi): void {
  runtime = api.runtime;
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
  const { viewId, originSessionKey, serverName } = app ?? {};
  return typeof viewId === "string" && typeof originSessionKey === "string" && typeof serverName === "string"
    ? { viewId, sessionKey: originSessionKey, server: serverName }
    : undefined;
}

/** The view's document and call, read while the gateway still holds it; undefined when it no longer does. */
export async function fetchMcpApp({ viewId, sessionKey, server }: McpAppView): Promise<McpApp | undefined> {
  if (!runtime) return undefined;
  try {
    const view = await runtime.gateway.request<McpAppViewResponse>(
      "mcp.app.view",
      { sessionKey, viewId },
      { timeoutMs: VIEW_TIMEOUT_MS },
    );
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
    pluginDebug(`mcp app view ${viewId} from ${server} unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

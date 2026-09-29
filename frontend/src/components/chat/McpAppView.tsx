import { useEffect, useRef, useState } from "react";
import { ArrowRight01Icon, Plug01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { Tile } from "@/components/McpConnectCard";
import { useTheme } from "@/hooks/useTheme";
import type { McpApp } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { type McpBrand, mcpBrand, signInDomain } from "@/lib/mcpBrands";
import { cn } from "@/lib/utils";

const PROTOCOL_VERSION = "2026-01-26";
const API_BASE = (import.meta.env.VITE_CLAWBITS_API_URL as string | undefined)?.trim() ?? "";
const MAX_HEIGHT = 1200;

/** Our theme tokens under the host style variable names MCP Apps read. */
const STYLE_VARIABLES = {
  "--color-background-primary": "--background",
  "--color-background-secondary": "--card",
  "--color-text-primary": "--foreground",
  "--color-text-secondary": "--muted-foreground",
  "--color-text-danger": "--destructive",
  "--color-border-primary": "--border",
} as const;

/** The heights views last reported, so a row the list remounts comes back at its size. */
const heights = new Map<string, number>();

interface Message {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: { url?: unknown; height?: unknown };
}

interface Reply {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function hostContext(theme: "light" | "dark") {
  const root = getComputedStyle(document.documentElement);
  const variables = Object.fromEntries(Object.entries(STYLE_VARIABLES).map(([name, token]) => [name, root.getPropertyValue(token).trim()]));
  return { theme, displayMode: "inline", availableDisplayModes: ["inline"], styles: { variables } };
}

function Mark({ brand, host }: { brand?: McpBrand; host: string | null }) {
  const [failed, setFailed] = useState(false);
  if (brand || !host || failed) return <Tile brand={brand} glyph={Plug01Icon} className="size-5" />;
  return <img src={`https://${signInDomain(host)}/favicon.ico`} alt="" className="size-5 shrink-0 rounded-md" onError={() => { setFailed(true); }} />;
}

/** A tool call's MCP App view, read-only: the server's document in a sandboxed frame, fed the call it renders. */
export function McpAppView({ id, app }: { id: string; app: McpApp }) {
  const { resolvedTheme } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useRef(resolvedTheme);
  const ready = useRef(false);
  const [open, setOpen] = useState(true);
  const [height, setHeight] = useState(() => heights.get(id) ?? 0);
  const brand = app.host ? mcpBrand(app.host) : undefined;
  const name = brand?.name ?? app.server.charAt(0).toUpperCase() + app.server.slice(1);

  useEffect(() => {
    const view = frame.current?.contentWindow;
    if (!view) return;
    const send = (reply: Reply) => { view.postMessage({ jsonrpc: "2.0", ...reply }, "*"); };
    const onMessage = ({ source, data }: MessageEvent<Message>) => {
      if (source !== view || data?.jsonrpc !== "2.0") return;
      const { id: request, method, params } = data;
      if (method === "ui/initialize") {
        send({
          id: request,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            hostInfo: { name: "clawbits", version: "1" },
            hostCapabilities: { openLinks: {} },
            hostContext: hostContext(theme.current),
          },
        });
      } else if (method === "ui/notifications/initialized") {
        ready.current = true;
        send({ method: "ui/notifications/tool-input", params: { arguments: app.input } });
        send({ method: "ui/notifications/tool-result", params: app.result });
      } else if (method === "ui/notifications/size-changed" && typeof params?.height === "number") {
        const next = Math.min(Math.ceil(params.height), MAX_HEIGHT);
        heights.set(id, next);
        setHeight(next);
      } else if (method === "ui/open-link" && typeof params?.url === "string" && params.url.startsWith("https://")) {
        void openExternal(params.url);
        send({ id: request, result: {} });
      } else if (method && request !== undefined) {
        send({ id: request, error: { code: -32601, message: `${method} is not supported` } });
      }
    };
    addEventListener("message", onMessage);
    return () => { removeEventListener("message", onMessage); };
  }, [app, id]);

  useEffect(() => {
    theme.current = resolvedTheme;
    if (ready.current) {
      frame.current?.contentWindow?.postMessage(
        { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: hostContext(resolvedTheme) },
        "*",
      );
    }
  }, [resolvedTheme]);

  return (
    <div className="my-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen(!open); }}
        className="flex min-h-8 w-full items-center gap-2 text-left text-[13px]/5"
      >
        <Mark brand={brand} host={app.host} />
        <span className="truncate font-medium text-foreground">{name}</span>
        <Icon icon={ArrowRight01Icon} className={cn("ml-auto size-3 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
      </button>
      <iframe
        ref={frame}
        hidden={!open}
        title={name}
        sandbox="allow-scripts"
        src={`${API_BASE}/api/mcp-apps/${app.resource}`}
        style={{ height, colorScheme: resolvedTheme }}
        className="block w-full border-0"
      />
    </div>
  );
}

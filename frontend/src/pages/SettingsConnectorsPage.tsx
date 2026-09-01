import { useEffect, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Link01Icon as LinkIcon } from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import {
  connectProvider,
  disconnectProvider,
  getConnectors,
  type Connector,
} from "@/lib/api";
import { confirm } from "@/lib/confirm";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const ERROR_MESSAGES: Record<string, string> = {
  oauth_state_mismatch: "The connection expired. Try Connect again.",
  connector_link_requires_login: "Sign in first, then connect GitHub.",
  github_oauth_failed: "GitHub authorization failed. Try again.",
  github_not_configured: "GitHub connector isn't set up on this server yet.",
  github_already_linked:
    "That GitHub account is already linked to another Clawbits user.",
  github_oauth_access_denied: "GitHub authorization was cancelled.",
};

interface ConnectorBrand {
  tile: string;
  icon: ReactNode;
}

/** Primer Octicons mark-github-24 — GitHub 2026 Invertocat */
function GithubGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-white" aria-hidden="true">
      <path d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943" />
    </svg>
  );
}

/** Simple Icons — Notion */
function NotionGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-white" aria-hidden="true">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
    </svg>
  );
}

/** Simple Icons — Gmail */
function GmailGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"
      />
    </svg>
  );
}

const CONNECTOR_BRANDS: Record<string, ConnectorBrand> = {
  github: {
    tile: "#181717",
    icon: <GithubGlyph />,
  },
  notion: {
    tile: "#000000",
    icon: <NotionGlyph />,
  },
  gmail: {
    tile: "#FCE8E6",
    icon: <GmailGlyph />,
  },
};

function ConnectorBrandIcon({ provider }: { provider: string }) {
  const brand = CONNECTOR_BRANDS[provider];
  if (!brand) {
    return (
      <div
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold uppercase text-muted-foreground"
        aria-hidden
      >
        {provider.slice(0, 1)}
      </div>
    );
  }
  return (
    <div
      className="flex size-9 shrink-0 items-center justify-center rounded-lg"
      style={{ backgroundColor: brand.tile }}
      aria-hidden
    >
      {brand.icon}
    </div>
  );
}

function statusLabel(c: Connector): string {
  if (c.status === "connected") {
    return c.handle ? `@${c.handle.replace(/^@/, "")}` : "Connected";
  }
  if (c.status === "coming_soon") return "Coming soon";
  return "Not connected";
}

function ConnectorRow({
  connector,
  busy,
  onConnect,
  onDisconnect,
}: {
  connector: Connector;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const connected = connector.status === "connected";
  const soon = connector.status === "coming_soon";

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-4 py-3 last:border-b-0",
        soon && "opacity-60",
      )}
    >
      <ConnectorBrandIcon provider={connector.provider} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{connector.label}</div>
        <div className="truncate text-xs text-muted-foreground">
          {statusLabel(connector)}
        </div>
      </div>
      {connected ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => { onDisconnect(); }}
        >
          Disconnect
        </Button>
      ) : (
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={busy || soon}
          onClick={() => { onConnect(); }}
        >
          Connect
        </Button>
      )}
    </div>
  );
}

export default function SettingsConnectorsPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();

  const listQuery = useQuery({
    queryKey: queryKeys.connectors,
    queryFn: getConnectors,
  });

  useEffect(() => {
    const connected = params.get("connected");
    const error = params.get("error");
    if (!connected && !error) return;
    if (connected) {
      toast.success(
        connected === "github" ? "GitHub connected" : `${connected} connected`,
      );
      void qc.invalidateQueries({ queryKey: queryKeys.connectors });
    }
    if (error) {
      const msg =
        ERROR_MESSAGES[error]
        ?? (error.startsWith("github_oauth_")
          ? "GitHub authorization failed. Try again."
          : "Couldn't connect. Try again.");
      toast.error(msg);
    }
    setParams({}, { replace: true });
  }, [params, qc, setParams]);

  const connectMutation = useMutation({
    mutationFn: (provider: string) => connectProvider(provider),
    onSuccess: (result) => {
      if (result.status === "redirect" && result.url) {
        window.location.href = result.url;
        return;
      }
      void qc.invalidateQueries({ queryKey: queryKeys.connectors });
      toast.success(
        result.connector?.handle
          ? `Connected as @${result.connector.handle.replace(/^@/, "")}`
          : "Connected",
      );
    },
    onError: (err) => {
      toast.error(errMsg(err, "Couldn't connect"));
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: (provider: string) => disconnectProvider(provider),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.connectors });
      toast.success("Disconnected");
    },
    onError: (err) => {
      toast.error(errMsg(err, "Couldn't disconnect"));
    },
  });

  const busy = connectMutation.isPending || disconnectMutation.isPending;
  const connectors = listQuery.data?.connectors ?? [];

  const handleDisconnect = async (provider: string, label: string) => {
    const ok = await confirm({
      title: `Disconnect ${label}?`,
      description:
        "Clawbits will forget this link. You can reconnect anytime. "
        + "This does not change how you sign in.",
    });
    if (!ok) return;
    disconnectMutation.mutate(provider);
  };

  return (
    <div className="space-y-6">
      <PageHeader icon={LinkIcon} title="Connectors" />

      <p className="text-sm text-muted-foreground">
        Link accounts so Clawbits can recognize you on other services.
        We only store your public profile (username, id) - never passwords
        or access tokens.
      </p>

      <div className="overflow-hidden rounded-lg border">
        {listQuery.isLoading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
        ) : connectors.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            No connectors available.
          </div>
        ) : (
          connectors.map((c) => (
            <ConnectorRow
              key={c.provider}
              connector={c}
              busy={busy}
              onConnect={() => { connectMutation.mutate(c.provider); }}
              onDisconnect={() => { void handleDisconnect(c.provider, c.label); }}
            />
          ))
        )}
      </div>
    </div>
  );
}

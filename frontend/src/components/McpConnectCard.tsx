import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight01Icon, Plug01Icon, Tick02Icon, Unlink02Icon } from "@hugeicons/core-free-icons";
import { type AppIcon, Icon } from "@/components/Icon";
import { SQUIRCLE_D } from "@/components/home/tiles";
import { Button } from "@/components/ui/button";
import { claimMcpConnect, getMcpConnectLink } from "@/lib/api";
import { isDesktop, openExternal } from "@/lib/desktop";
import { type McpBrand, mcpBrand, signInDomain } from "@/lib/mcpBrands";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const PILL = "inline-flex h-8 shrink-0 items-center gap-1 rounded-lg pr-3 pl-2.5 text-sm font-medium whitespace-nowrap";

/** The service's mark on its squircle tile; a neutral tile, with an optional glyph, for anything else. */
export function Tile({ brand, glyph, className }: { brand?: McpBrand; glyph?: AppIcon; className?: string }) {
  const colors = brand && brand.tile !== "ink" ? brand.tile : undefined;
  return (
    <span className={cn("relative grid size-10 shrink-0 place-items-center", className)}>
      <svg viewBox="0 0 1 1" aria-hidden className="absolute inset-0 size-full">
        <path d={SQUIRCLE_D} fill={colors?.fill} className={cn(!brand && "fill-foreground/6", brand && !colors && "fill-foreground")} />
        <path
          d={SQUIRCLE_D}
          fill="none"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          transform="translate(0.0125 0.0125) scale(0.975)"
          className="stroke-foreground/10"
        />
      </svg>
      {brand ? (
        <svg viewBox={brand.viewBox} aria-hidden fill={colors?.mark} className={cn("relative size-[55%]", !colors && "fill-background")}>
          <path d={brand.d} />
        </svg>
      ) : (
        glyph && <Icon icon={glyph} className="relative size-1/2 text-muted-foreground" />
      )}
    </span>
  );
}

/** An agent's request to sign in to an MCP server; its text comes from the server, never the message. The logo and
 *  proper name appear only when the sign-in host belongs to a known service. */
export function McpConnectCard({ linkId }: { linkId: string }) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.mcpConnectLink(linkId);
  const { data } = useQuery({
    queryKey,
    queryFn: () => getMcpConnectLink(linkId),
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.status === "connecting" ? 2000 : false),
  });
  const connect = useMutation({
    mutationFn: () => claimMcpConnect(linkId, isDesktop ? "desktop" : "web"),
    onSuccess: ({ url }) => {
      if (isDesktop) void openExternal(url);
      else window.location.assign(url);
    },
    onError: () => queryClient.invalidateQueries({ queryKey }),
  });

  const status = data === null ? "inactive" : (data?.status ?? "loading");
  const brand = data ? mcpBrand(data.host) : undefined;
  const name = brand?.name ?? data?.server;
  const agent = data?.agent_name;
  const domain = data && (
    <span title={data.host} className="font-medium text-foreground">
      {signInDomain(data.host)}
    </span>
  );
  const title = {
    open: `Connect ${name}`,
    connecting: `Connecting ${name}`,
    connected: `Signed in to ${name}`,
    inactive: "This link is no longer active",
    loading: "Connect MCP server",
  }[status];
  const line: ReactNode = {
    open: <>{agent} asks you to sign in at {domain}.</>,
    connecting: `${agent} is finishing the sign-in.`,
    connected: <>{agent} is signed in at {domain}.</>,
    inactive: "Ask the agent for a new one.",
    loading: null,
  }[status];

  return (
    <span className="my-1 grid w-full max-w-lg grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-[14px] bg-card p-3">
      <Tile brand={brand} glyph={data === null ? Unlink02Icon : data && Plug01Icon} />
      <span aria-live={data ? "polite" : undefined} aria-atomic="true" className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        {line && <span className="block text-[13px]/[18px] text-pretty text-muted-foreground">{line}</span>}
      </span>
      {status === "open" && (
        <Button size="sm" disabled={connect.isPending} onClick={() => { connect.mutate(); }}>
          Connect
          <Icon icon={ArrowUpRight01Icon} data-icon="inline-end" className="size-3.5" />
        </Button>
      )}
      {status === "connecting" && (
        <span className={cn(PILL, "bg-foreground/6 text-foreground/75")}>
          <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current/20 border-t-current" />
          Connecting
        </span>
      )}
      {status === "connected" && (
        <span className={cn(PILL, "bg-emerald-600/14 text-emerald-800 dark:bg-emerald-500/16 dark:text-emerald-400")}>
          <Icon icon={Tick02Icon} className="size-3.5" />
          Connected
        </span>
      )}
    </span>
  );
}

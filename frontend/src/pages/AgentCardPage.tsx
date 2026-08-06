/**
 * AgentCardPage — an agent's "home": its collectible card centered on a calm
 * seed-keyed aura, flanked by big quick-nav buttons (Inbox / Automations on the
 * left, Manage / Chat on the right) that fade + rise in like the home launchpad.
 * This is the index route for an agent (`/agents/:id`); the buttons deep-link to
 * the routed subpages. The agent profile is loaded once by {@link AgentShell}.
 */
import { type CSSProperties, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Mail01Icon,
  Clock05Icon,
  Settings02Icon,
  BubbleChatIcon,
  TerminalIcon,
  CrabIcon,
  DashboardSquare01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { agentDisplay } from "@/lib/agentDisplay";
import { auraFromSeed } from "@/lib/gradientFromSeed";
import { useAgentStatus } from "@/hooks/useAgentPresence";
import { createOrGetMmDirect, listAgentAutomations, getReefConnection } from "@/lib/api";
import { supportsAutomations } from "@/lib/automations";
import { setReefToken } from "@/lib/reefApi";
import { OpenSurfaceDialog } from "@/components/reef/OpenSurfaceDialog";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { agentBreadcrumbs } from "@/components/agent/agentBreadcrumbs";
import type { AgentOutletContext } from "@/components/agent/AgentShell";
import { morphAgentCardNavigation, waitForElement } from "@/lib/viewTransition";
import { AgentCollectibleCard } from "@/components/agent-card";

// The card is height-capped so the whole composition — header clearance, the
// card, its description, and the flanking nav pills — fits the viewport without
// the main column scrolling. `reservePx` is the vertical space everything ELSE
// needs: it's larger when a description sits below the card (it can wrap up to 3
// lines, line-clamp-3) and smaller without one. 0.6338 = 360/568 (card W/H).
const cardWidthCss = (reservePx: number) =>
  `min(500px, 100%, calc((100dvh - ${String(reservePx)}px) * 0.6338))`;
// No description → just header clearance + paddings + the nav pills.
const CARD_RESERVE_BARE = 220;
// With a description block (mt-5 + up to 3 lines) below the card.
const CARD_RESERVE_DESC = 300;

// Shared button surface: a quiet pill (icon + label inline). `animate-in …`
// gives the same fade + rise as the home launchpad blocks; the per-button delay
// (+ fill-mode both, set inline) staggers them in. `flex-1` makes them share a
// row when stacked below the card on narrow widths; `@4xl:w-full` makes them
// fill their column when they flank the card.
const NAV_BTN_CLS =
  "group relative flex h-14 min-w-0 flex-1 items-center justify-center gap-2.5 rounded-full border border-border/70 bg-card px-6 text-[15px] font-medium text-foreground shadow-xs transition duration-150 will-change-transform hover:-translate-y-0.5 hover:border-border hover:bg-muted/30 hover:shadow-sm active:translate-y-0 active:scale-[0.98] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none animate-in fade-in slide-in-from-bottom-2 duration-500 ease-out @4xl:w-full @4xl:flex-none";

function CardNavButton({
  icon,
  label,
  to,
  onNavigate,
  onClick,
  disabled,
  delay,
  count,
}: {
  icon: IconSvgElement;
  label: string;
  /** Present → renders a routed <Link>; absent → an action <button>. */
  to?: string;
  onNavigate?: () => void;
  onClick?: () => void;
  disabled?: boolean;
  delay: number;
  /** Optional trailing count pill (e.g. active automations). Omitted when 0. */
  count?: number;
}) {
  const style: CSSProperties = { animationDelay: `${String(delay)}ms`, animationFillMode: "both" };
  const inner = (
    <>
      <Icon icon={icon} className="size-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
      <span className="truncate">{label}</span>
      {Boolean(count) && (
        <span className="absolute right-4 top-1/2 flex h-5 min-w-5 -translate-y-1/2 shrink-0 items-center justify-center rounded-full bg-muted px-1.5 text-[12px] font-semibold tabular-nums text-muted-foreground transition-colors group-hover:bg-background group-hover:text-foreground">
          {count}
        </span>
      )}
    </>
  );
  return to ? (
    <Link to={to} viewTransition onClick={onNavigate} style={style} className={NAV_BTN_CLS}>
      {inner}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={style}
      className={cn(NAV_BTN_CLS, "disabled:pointer-events-none disabled:opacity-60")}
    >
      {inner}
    </button>
  );
}

/** A side column of buttons: a shared row below the card on narrow widths, a
 *  vertical stack flanking it once there's room. (`w-56` fits the widest label,
 *  "Automations", plus its count pill, inside an inline pill with air around it.) */
function ButtonColumn({ order, children }: { order: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex w-full max-w-[460px] gap-3 @4xl:w-56 @4xl:max-w-none @4xl:flex-col @4xl:gap-4 @4xl:self-center",
        order,
      )}
    >
      {children}
    </div>
  );
}

export default function AgentCardPage() {
  const navigate = useNavigate();
  const { orgId, agentId, profile, isLoading, isError } = useOutletContext<AgentOutletContext>();

  const seed = profile?.agent_id ?? agentId ?? "agent";
  const base = `/agents/${encodeURIComponent(agentId ?? "")}`;

  // Live dot on the card. The profile snapshot bridges the pre-seed frame;
  // afterwards the provider (SSE + 30s tick) keeps it current.
  const status = useAgentStatus(agentId, profile?.last_alive_at);

  // Automations count for the nav pill — operator-only, same endpoint the
  // Automations tab itself lists from.
  const isOperator = Boolean(profile?.is_operator);
  const automationsQuery = useQuery({
    queryKey: queryKeys.automationsForAgent(orgId, agentId ?? ""),
    queryFn: () => listAgentAutomations(orgId, agentId ?? ""),
    enabled: Boolean(orgId) && Boolean(agentId) && isOperator,
  });
  const automationsCount = automationsQuery.data?.automations.length ?? 0;

  // Chat is an action, not a route: open/create the DM channel and jump to it.
  const openChat = useMutation({
    mutationFn: () => createOrGetMmDirect(orgId, "agent", agentId ?? ""),
    onSuccess: (channel) => { void navigate(`/channels/${channel.channel_id}`); },
    onError: (err: unknown) => { toast.error(errMsg(err, "Couldn't open chat")); },
  });

  // Reverse hero morph: shrink + glide this centered card back into its slot in
  // the /agents binder. The card here is the (statically-named) "old" snapshot;
  // we name the matching grid card as the "new" one once it renders. Only wired
  // on the card page — the other subpages have no card on screen to morph from.
  const backToAll = (e: React.MouseEvent) => {
    // Leave modified / non-primary clicks alone (open-in-new-tab, etc.).
    if (!agentId || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const selector = `[data-agent-card-id="${agentId.replace(/["\\]/g, "\\$&")}"]`;
    morphAgentCardNavigation({
      navigate: () => { void navigate("/agents"); },
      waitForTarget: () => waitForElement(selector),
      nameTarget: true,
    });
  };

  // Deep-linking to a subpage is a plain cross-fade, not a card morph — so drop
  // the card's hero name for that navigation, else it plays a stray isolated
  // animation (it's only a morph target for the grid ⇆ card pair).
  const suppressCardMorph = () => {
    document.querySelector<HTMLElement>(".vt-agent-card")?.style.setProperty("view-transition-name", "none");
  };

  const canChat = Boolean(profile?.can_dm);

  // Reef-hosted agents get quick "Terminal" / "OpenClaw gateway" actions. Both
  // need the org's connected Reef (its api_url); the one-time access password is
  // collected by OpenSurfaceDialog on open (never stored). Operator-only.
  const isReefHosted = Boolean(profile?.reef_sandbox_id);
  const reefConnQuery = useQuery({
    queryKey: queryKeys.reefConnection(orgId),
    queryFn: () => getReefConnection(orgId),
    enabled: Boolean(orgId) && isOperator && isReefHosted,
    retry: false,
  });
  const reefApiUrl = reefConnQuery.data?.api_url ?? null;
  const canOpenSurfaces = isOperator && isReefHosted && Boolean(reefApiUrl);
  const [openSurface, setOpenSurface] = useState<"ui" | "terminal" | null>(null);

  return (
    <div className="@container relative flex flex-1 flex-col items-center justify-start px-4 pt-4 pb-16 @4xl:justify-center">
      <PageHeader breadcrumb={agentBreadcrumbs(agentId, profile, undefined, { onAll: backToAll })} />
      {/* Soft seed-keyed aura behind the card, clipped to the page so its large
          blurred disc can't add scroll. (The card's own shadow lives outside
          this layer, so it stays unclipped.) */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div
          className="absolute left-1/2 top-1/2 size-[860px] -translate-x-1/2 -translate-y-1/2 opacity-60 blur-2xl"
          style={{ background: auraFromSeed(seed) }}
        />
      </div>

      {isLoading ? (
        // Carries the hero name too (same box + aspect as the card) so a cold
        // click — where the profile is still loading at snapshot time — still
        // has a morph target to grow + glide into; the real card cross-fades in
        // once it loads.
        <div
          className="vt-agent-card aspect-[360/568] animate-pulse rounded-[2.5rem] bg-muted/50"
          style={{ width: cardWidthCss(CARD_RESERVE_BARE) }}
        />
      ) : isError || !profile ? (
        <div className="text-sm text-muted-foreground">Couldn&apos;t load this agent.</div>
      ) : (
        <div className="flex w-full flex-col items-center gap-6 @4xl:flex-row @4xl:items-center @4xl:justify-center @4xl:gap-6">
          {/* Left rail — Chat (anyone who may DM) / Automations + Inbox
              (operator-only). Sits below the card when stacked (order-2), left of
              it when flanking (order-1). */}
          {(isOperator || canChat) && (
            <ButtonColumn order="order-2 @4xl:order-1">
              {canChat && (
                <CardNavButton
                  icon={BubbleChatIcon}
                  label="Chat"
                  onClick={() => { openChat.mutate(); }}
                  disabled={openChat.isPending}
                  delay={140}
                />
              )}
              {/* Hidden for runtimes without a cron reconciler (hermes/
                  ironclaw) - unless stuck rows still exist to clean up. */}
              {isOperator &&
                (supportsAutomations(profile.agent_type) || automationsCount > 0) && (
                <CardNavButton
                  icon={Clock05Icon}
                  label="Automations"
                  to={`${base}/automations`}
                  onNavigate={suppressCardMorph}
                  delay={220}
                  count={automationsCount}
                />
              )}
              {isOperator && (
                <CardNavButton
                  icon={Mail01Icon}
                  label="Inbox"
                  to={`${base}/inbox`}
                  onNavigate={suppressCardMorph}
                  delay={300}
                />
              )}
            </ButtonColumn>
          )}

          {/* Card (the hero) — stays first when stacked, centered when flanking. */}
          <div
            className="order-1 flex max-w-full shrink-0 flex-col items-center @4xl:order-2"
            style={{ width: cardWidthCss(profile.description ? CARD_RESERVE_DESC : CARD_RESERVE_BARE) }}
          >
            <AgentCollectibleCard
              className="vt-agent-card"
              seed={seed}
              name={agentDisplay(profile)}
              handle={profile.agent_id}
              joined={profile.creation_time}
              avatarUrl={profile.avatar?.url}
              email={profile.email_address}
              status={status}
              runsOnReef={Boolean(profile.reef_sandbox_id)}
              agentType={profile.agent_type}
              pluginVersion={profile.plugin_version}
              onReefClick={() => { void navigate("/settings/reef"); }}
              operator={
                profile.operator
                  ? {
                      name: profile.operator.display_name ?? "operator",
                      avatarUrl: profile.operator.avatar?.url,
                    }
                  : null
              }
            />
            {profile.description && (
              // Same fade + rise as the nav pills, timed just ahead of them so
              // the page settles card → description → buttons.
              <p
                className="mt-5 line-clamp-3 max-w-[42ch] text-balance text-center font-serif text-[17px] italic leading-relaxed text-muted-foreground animate-in fade-in slide-in-from-bottom-2 duration-500 ease-out"
                style={{ animationDelay: "100ms", animationFillMode: "both" }}
              >
                &ldquo;{profile.description}&rdquo;
              </p>
            )}
          </div>

          {/* Right rail — (reef-hosted) Terminal + OpenClaw UI, then Manage.
              Operator-only. */}
          {isOperator && (
            <ButtonColumn order="order-3">
              {canOpenSurfaces && (
                <>
                  <CardNavButton
                    icon={TerminalIcon}
                    label="Terminal"
                    onClick={() => { setOpenSurface("terminal"); }}
                    delay={140}
                  />
                  {/* The primary web surface is runtime-specific: OpenClaw's
                      Control UI vs the Hermes dashboard. */}
                  <CardNavButton
                    icon={profile.agent_type === "hermes" ? DashboardSquare01Icon : CrabIcon}
                    label={profile.agent_type === "hermes" ? "Dashboard" : "OpenClaw UI"}
                    onClick={() => { setOpenSurface("ui"); }}
                    delay={200}
                  />
                </>
              )}
              <CardNavButton
                icon={Settings02Icon}
                label="Manage"
                to={`${base}/manage`}
                onNavigate={suppressCardMorph}
                delay={canOpenSurfaces ? 260 : 140}
              />
            </ButtonColumn>
          )}
        </div>
      )}

      {openSurface !== null && profile?.reef_sandbox_id && reefApiUrl && (
        <OpenSurfaceDialog
          target={{ id: profile.reef_sandbox_id, surface: openSurface }}
          apiUrl={reefApiUrl}
          onClose={() => { setOpenSurface(null); }}
          onAuthReject={() => { setReefToken(null); }}
        />
      )}
    </div>
  );
}

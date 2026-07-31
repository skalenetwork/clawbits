import { useState } from "react"
import { toast } from "sonner"
import {
  Add01Icon as Plus,
  ArrowUpRight01Icon,
  Copy01Icon,
  Delete02Icon,
  PaintBoardIcon,
  PlayIcon,
  RefreshIcon,
  Search01Icon,
  StopIcon,
  Tick01Icon as Check,
} from "@hugeicons/core-free-icons"
import type { FleetEntry, SandboxState } from "@/lib/api"
import { agentTypeOf } from "@/lib/agentTypes"
import { AGENT_COLORS, COLOR_LABEL, COLOR_SWATCH, tintFor } from "@/lib/colors"
import { useSandboxDetail } from "@/lib/queries"
import { cn, controlUiAuthUrl, formatPercent, shortAge, terminalAuthUrl } from "@/lib/utils"
import { Icon } from "@/components/Icon"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { ContextualHeader } from "./ContextualHeader"

const STATE_DOT: Record<SandboxState, string> = {
  running: "bg-success",
  creating: "bg-warning animate-pulse",
  stopped: "bg-muted-foreground/60",
  failed: "bg-destructive",
  destroyed: "bg-muted-foreground/40",
}

export interface FleetSidebarProps {
  agents: FleetEntry[]
  total: number
  loading: boolean
  error: string | null
  selectedId: string | null
  onSelect: (id: string) => void
  search: string
  onSearch: (v: string) => void
  onCreate: () => void
  onStart: (id: string) => void
  onStop: (id: string) => void
  onRestart: (id: string) => void
  onRemove: (id: string) => void
  onSetColor: (id: string, color: string) => void
  /** sandbox_id with a start/stop/restart/destroy mutation in flight, if any. */
  pendingId: string | null
}

/**
 * The Fleet contextual sidebar — the card's left pane. A unified header with a
 * create action, an always-visible search + state-filter strip, and the agent
 * roster below it. Split out of the old single Sidebar component: brand, theme,
 * and runtime health moved to the rail (AppRail).
 */
export function FleetSidebar(props: FleetSidebarProps) {
  return (
    <>
      <ContextualHeader
        title="Fleet"
        action={
          <button
            type="button"
            onClick={props.onCreate}
            title="New agent VM"
            aria-label="New agent VM"
            // Primary-accent pill with an enlarged hit area — the same create
            // affordance as the clawbits Chats sidebar's header button.
            className="relative flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground transition duration-100 after:absolute after:-inset-2 hover:bg-primary/90 active:scale-90"
          >
            <Icon icon={Plus} className="size-4" />
          </button>
        }
      />

      {/* Search — pinned above the scrolling roster. */}
      <div className="shrink-0 px-2 pt-2 pb-1">
        <div className="relative">
          <Icon
            icon={Search01Icon}
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <SidebarInput
            value={props.search}
            onChange={(e) => props.onSearch(e.target.value)}
            placeholder="Search agents…"
            className="h-8 pl-8 text-xs md:text-xs"
          />
        </div>
      </div>

      {/* Roster. */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <SidebarMenu>
          {props.agents.map((a) => (
            <AgentRow
              key={a.sandbox_id}
              entry={a}
              active={a.sandbox_id === props.selectedId}
              onClick={() => props.onSelect(a.sandbox_id)}
              onStart={props.onStart}
              onStop={props.onStop}
              onRestart={props.onRestart}
              onRemove={props.onRemove}
              onSetColor={props.onSetColor}
              pending={props.pendingId === a.sandbox_id}
            />
          ))}
          {props.loading && props.agents.length === 0 && (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</li>
          )}
          {props.error && (
            <li className="px-2 py-6 text-center text-sm text-destructive">{props.error}</li>
          )}
          {!props.loading && !props.error && props.agents.length === 0 && (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">
              {props.total === 0 ? "No agents yet." : "No matches."}
            </li>
          )}
        </SidebarMenu>
      </div>
    </>
  )
}

function AgentRow({
  entry,
  active,
  onClick,
  onStart,
  onStop,
  onRestart,
  onRemove,
  onSetColor,
  pending,
}: {
  entry: FleetEntry
  active: boolean
  onClick: () => void
  onStart: (id: string) => void
  onStop: (id: string) => void
  onRestart: (id: string) => void
  onRemove: (id: string) => void
  onSetColor: (id: string, color: string) => void
  pending: boolean
}) {
  const at = agentTypeOf(entry)
  const sub = entry.metrics
    ? `${entry.state} · ${formatPercent(entry.metrics.cpu_percent)}`
    : entry.state

  // The web-UI url + password live only on the detail endpoint, not on the
  // fleet row. Fetch it lazily the first time the menu opens (then React Query
  // caches it) so we don't hit /fleet/:id for every agent up front.
  const [armed, setArmed] = useState(false)
  const detail = useSandboxDetail(armed ? entry.sandbox_id : null)
  const state = detail.data?.state ?? entry.state
  const url = detail.data?.access?.url ?? null
  const terminalUrl = detail.data?.access?.terminal_url ?? null
  const password = detail.data?.access?.password ?? null
  const canStart = state === "stopped" || state === "failed"
  const canStop = state === "running"

  const copyPassword = () => {
    if (!password) return
    navigator.clipboard?.writeText(password)
    toast.success("Copied password")
  }

  return (
    <ContextMenu onOpenChange={(open) => open && setArmed(true)}>
      <ContextMenuTrigger render={<SidebarMenuItem />}>
        <SidebarMenuButton
          size="lg"
          isActive={active}
          onClick={onClick}
          className="h-11 items-center gap-2 rounded-lg px-2.5 text-[12px] [&_svg]:size-[18px]"
        >
          {/* Agent avatar — 26px rounded tile with a subtle brand-matching tint
              behind the agent's logo; the logo is inset (18px) so it doesn't
              crowd the tile edge. */}
          <span className="relative flex shrink-0 items-center">
            <span
              className="flex size-[26px] items-center justify-center overflow-hidden rounded-lg"
              style={{ background: tintFor(entry.color, at) }}
            >
              <at.Icon className="size-[18px]" />
            </span>
            <span
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar",
                STATE_DOT[entry.state],
              )}
            />
          </span>
          <div className="flex min-w-0 flex-1 flex-col justify-center leading-tight">
            <span className="min-w-0 truncate">{entry.sandbox_id}</span>
            <span className="min-w-0 truncate text-[11px] font-normal capitalize text-muted-foreground">
              {sub}
            </span>
          </div>
          {entry.created_at && (
            <span
              title={`Created ${entry.created_at}`}
              className="shrink-0 self-center text-[10px] tabular-nums text-muted-foreground/60"
            >
              {shortAge(entry.created_at)}
            </span>
          )}
        </SidebarMenuButton>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {/* Web surfaces — available once the agent is exposed (running). Open via
            window.open in the click handler, NOT a render-anchor: a base-ui menu
            closes on select, which breaks a target="_blank" anchor's user-gesture
            chain and pops a blank tab (about:blank). */}
        <ContextMenuItem
          disabled={!url}
          onClick={() =>
            url &&
            window.open(controlUiAuthUrl(url, password ?? ""), "_blank", "noopener,noreferrer")
          }
        >
          <Icon icon={ArrowUpRight01Icon} /> Open Control UI
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!terminalUrl}
          onClick={() =>
            terminalUrl &&
            window.open(
              terminalAuthUrl(terminalUrl, password ?? ""),
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          <Icon icon={ArrowUpRight01Icon} /> Open terminal
        </ContextMenuItem>
        <ContextMenuItem disabled={!password} onClick={copyPassword}>
          <Icon icon={Copy01Icon} /> Copy password
        </ContextMenuItem>

        <ContextMenuSeparator />

        {canStop ? (
          <>
            <ContextMenuItem disabled={pending} onClick={() => onStop(entry.sandbox_id)}>
              <Icon icon={StopIcon} /> Stop
            </ContextMenuItem>
            <ContextMenuItem disabled={pending} onClick={() => onRestart(entry.sandbox_id)}>
              <Icon icon={RefreshIcon} /> Restart
            </ContextMenuItem>
          </>
        ) : (
          <ContextMenuItem
            disabled={pending || !canStart}
            onClick={() => onStart(entry.sandbox_id)}
          >
            <Icon icon={PlayIcon} /> Start
          </ContextMenuItem>
        )}

        {/* Recolour — managed agents only (drift VMs have no store record to hold it). */}
        {entry.managed && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Icon icon={PaintBoardIcon} /> Color
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {AGENT_COLORS.map((c) => (
                <ContextMenuItem key={c} onClick={() => onSetColor(entry.sandbox_id, c)}>
                  <span
                    className="size-3.5 shrink-0 rounded-full ring-1 ring-inset ring-black/15 dark:ring-white/20"
                    style={{ background: COLOR_SWATCH[c] }}
                  />
                  {COLOR_LABEL[c]}
                  {entry.color === c && (
                    <Icon icon={Check} className="ml-auto size-4 text-muted-foreground" />
                  )}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        <ContextMenuSeparator />

        <ContextMenuItem
          variant="destructive"
          disabled={pending}
          onClick={() => onRemove(entry.sandbox_id)}
        >
          <Icon icon={Delete02Icon} /> Remove
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

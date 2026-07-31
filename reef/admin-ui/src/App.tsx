import { useState } from "react"
import { Link, Navigate, Route, Routes, useMatch, useNavigate, useParams } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import type { FleetEntry } from "@/lib/api"
import { ApiError, hasAdminToken, isAuthError, setAdminToken } from "@/lib/api"
import { useFleet, useFleetActions } from "@/lib/queries"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppRail } from "@/components/AppRail"
import { FleetSidebar } from "@/components/sidebars/FleetSidebar"
import { PageHeaderSlotProvider } from "@/components/PageHeader"
import { AgentDetail } from "@/components/AgentDetail"
import { Home } from "@/components/Home"
import { Images } from "@/components/Images"
import { Settings } from "@/components/Settings"
import { CreateAgentDialog } from "@/components/create-agent/CreateAgentDialog"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { AuthDialog } from "@/components/AuthDialog"

export default function App() {
  const navigate = useNavigate()
  // The viewed agent lives in the URL (/agents/:id), not in component state — so
  // it's deep-linkable, refresh-safe, and back/forward navigable.
  const detailMatch = useMatch("/agents/:id")
  const routeId = detailMatch?.params.id ?? null

  const [search, setSearch] = useState("")
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  // The content card's unified page-header bar; pages portal their title +
  // actions into this node via <PageHeader/>.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)

  // Always-live: the fleet refetches on a fixed interval (no manual toggle).
  const fleet = useFleet(5000)
  const { start, stop, restart, destroy, setColor, setRestartPolicy } = useFleetActions()
  const queryClient = useQueryClient()

  // Token-gated Reef (REEF_ADMIN_TOKEN set): the fleet poll answers 401/403
  // until the operator unlocks. Submitting stores the token (lib/api) and
  // refetches everything; a wrong token just fails the next poll, which keeps
  // the dialog open with a "rejected" hint.
  const authRequired = isAuthError(fleet.error)
  const submitToken = (token: string) => {
    setAdminToken(token)
    void queryClient.invalidateQueries()
  }

  const all = fleet.data ?? []
  const q = search.trim().toLowerCase()
  const agents = q
    ? all.filter((e) =>
        [e.sandbox_id, e.image, e.tenant ?? "", e.profile ?? "", e.agent_type].some((s) =>
          s.toLowerCase().includes(q),
        ),
      )
    : all

  const pendingId = start.isPending
    ? (start.variables as string)
    : stop.isPending
      ? (stop.variables as string)
      : restart.isPending
        ? (restart.variables as string)
        : destroy.isPending
          ? (destroy.variables as string)
          : null

  const fleetError =
    fleet.error instanceof ApiError
      ? fleet.error.message
      : fleet.error
        ? String(fleet.error)
        : null

  const openAgent = (id: string) => navigate(`/agents/${id}`)

  const confirmDestroy = () => {
    const id = confirmId
    if (!id) return
    destroy.mutate(id, {
      onSuccess: () => {
        if (routeId === id) navigate("/") // leave the detail we just destroyed
      },
    })
    setConfirmId(null)
  }

  return (
    <SidebarProvider className="bg-background">
      <AppRail />

      {/* Content region — the inset around the floating card. pl-0 so the card
          abuts the rail: the rail's centered icons then sit with equal space on
          each side (window edge ↔ icon ↔ card). */}
      <div className="min-w-0 flex-1 py-2 pr-2 pl-0">
        <div className="flex h-full overflow-hidden rounded-xl border border-sidebar-border bg-panel shadow-sm">
          {/* Contextual sidebar — the card's left pane (desktop/tablet only). */}
          <aside
            data-vt-contextual=""
            className="hidden w-(--sidebar-width) shrink-0 flex-col border-r border-sidebar-border md:flex"
          >
            <FleetSidebar
              agents={agents}
              total={all.length}
              loading={fleet.isLoading}
              error={fleetError}
              selectedId={routeId}
              onSelect={openAgent}
              search={search}
              onSearch={setSearch}
              onCreate={() => setCreateOpen(true)}
              onStart={(id) => start.mutate(id)}
              onStop={(id) => stop.mutate(id)}
              onRestart={(id) => restart.mutate(id)}
              onRemove={setConfirmId}
              onSetColor={(id, color) => setColor.mutate({ id, color })}
              pendingId={pendingId}
            />
          </aside>

          {/* Content column. */}
          <PageHeaderSlotProvider value={headerSlot}>
            <div className="relative flex min-w-0 flex-1 flex-col">
              {/* Unified page-header bar — same height + bottom border as the
                  sidebar's ContextualHeader so the two line up as one header row
                  across the card. absolute + a translucent backdrop-blur so the
                  page content scrolls behind it (the body clears it with top
                  padding). Pages portal their title + actions in here. */}
              <div
                ref={setHeaderSlot}
                className="absolute inset-x-0 top-0 z-10 flex h-12 items-center justify-between gap-2 border-b border-sidebar-border bg-panel/80 px-3 backdrop-blur-xl supports-[backdrop-filter]:bg-panel/65"
              />
              <main className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                <div className="mx-auto w-full max-w-5xl px-4 pt-16 pb-12">
                  <Routes>
                    <Route
                      path="/"
                      element={
                        <Home agents={all} onCreate={() => setCreateOpen(true)} onSelect={openAgent} />
                      }
                    />
                    <Route
                      path="/agents/:id"
                      element={
                        <AgentDetailRoute
                          fleet={all}
                          fleetLoading={fleet.isLoading}
                          onStart={(id) => start.mutate(id)}
                          onStop={(id) => stop.mutate(id)}
                          onRestart={(id) => restart.mutate(id)}
                          onDestroy={setConfirmId}
                          onSetRestartPolicy={(id, policy) => setRestartPolicy.mutate({ id, policy })}
                          pendingId={pendingId}
                        />
                      }
                    />
                    <Route path="/images" element={<Images />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </div>
              </main>
            </div>
          </PageHeaderSlotProvider>
        </div>
      </div>

      <ConfirmDialog
        open={confirmId !== null}
        title={`Destroy ${confirmId ?? ""}?`}
        description="This permanently removes the microVM and its sandbox record. The persistent volume is left intact. This cannot be undone."
        confirmLabel="Yes, destroy"
        onConfirm={confirmDestroy}
        onCancel={() => setConfirmId(null)}
        pending={destroy.isPending}
      />

      <CreateAgentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onOpenAgent={openAgent}
      />

      <AuthDialog
        open={authRequired}
        rejected={authRequired && hasAdminToken()}
        onSubmit={submitToken}
      />
    </SidebarProvider>
  )
}

/** Resolves /agents/:id to its fleet row. Shows a loading state while the fleet
 *  first loads, and a not-found state when the id isn't in the (loaded) fleet —
 *  e.g. a stale/shared link or a since-destroyed VM. */
function AgentDetailRoute({
  fleet,
  fleetLoading,
  onStart,
  onStop,
  onRestart,
  onDestroy,
  onSetRestartPolicy,
  pendingId,
}: {
  fleet: FleetEntry[]
  fleetLoading: boolean
  onStart: (id: string) => void
  onStop: (id: string) => void
  onRestart: (id: string) => void
  onDestroy: (id: string) => void
  onSetRestartPolicy: (id: string, policy: string) => void
  pendingId: string | null
}) {
  const { id } = useParams()
  const entry = fleet.find((e) => e.sandbox_id === id) ?? null

  if (entry) {
    return (
      <AgentDetail
        key={entry.sandbox_id}
        entry={entry}
        live
        onStart={onStart}
        onStop={onStop}
        onRestart={onRestart}
        onDestroy={onDestroy}
        onSetRestartPolicy={onSetRestartPolicy}
        pending={pendingId === entry.sandbox_id}
      />
    )
  }

  if (fleetLoading) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading agent…</div>
  }

  return (
    <div className="space-y-3 py-16 text-center">
      <p className="text-sm text-muted-foreground">
        Agent <span className="font-mono text-foreground">{id}</span> not found — it may have been
        destroyed.
      </p>
      <Link to="/" className="inline-block text-sm font-medium text-primary hover:underline">
        ← Back to Home
      </Link>
    </div>
  )
}

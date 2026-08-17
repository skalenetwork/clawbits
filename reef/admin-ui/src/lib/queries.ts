import { useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  type AgentEnv,
  api,
  ApiError,
  type BuildImageIn,
  type EnvApplyResult,
  type EnvPatchIn,
  isAuthError,
  type CreateSandboxIn,
  type FleetEntry,
  type SandboxDetail,
} from "@/lib/api"

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : String(e))

export function useHealth() {
  return useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 10_000 })
}

/** Which AI providers have a reef-level key configured (presence booleans -
 *  `GET /providers`, admin-gated). Drives the create dialog's provider picker. */
export function useProviders(enabled = true) {
  return useQuery({
    queryKey: ["providers"],
    queryFn: api.providers,
    enabled,
    staleTime: 60_000,
    retry: (failureCount, error) => !isAuthError(error) && failureCount < 3,
  })
}

/** OpenRouter's live model catalog, reef-proxied (`GET
 *  /providers/openrouter/models`). Feeds the create dialog's model datalist
 *  when the openrouter provider is picked; a failure just leaves the free-text
 *  field without suggestions. */
export function useOpenRouterModels(enabled: boolean) {
  return useQuery({
    queryKey: ["openrouter-models"],
    queryFn: api.openrouterModels,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** Operator settings (`GET /settings`) - today the public-URL override. */
export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: api.settings,
    staleTime: 60_000,
    retry: (failureCount, error) => !isAuthError(error) && failureCount < 3,
  })
}

/** Set / clear the public-URL override (`PUT /settings`). Pass null to clear. */
export function useUpdateSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (publicUrl: string | null) => api.updateSettings(publicUrl),
    onSuccess: (r) => {
      qc.setQueryData(["settings"], r)
      toast.success("Settings saved")
    },
    onError: (e) => toast.error(errMsg(e)),
  })
}

export function useFleet(refetchInterval: number | false) {
  return useQuery({
    queryKey: ["fleet"],
    queryFn: () => api.fleet(),
    refetchInterval,
    // Auth failures aren't transient — surface them at once so the unlock
    // dialog appears without waiting out the default retries.
    retry: (failureCount, error) => !isAuthError(error) && failureCount < 3,
  })
}

export function useSandboxDetail(id: string | null, refetchInterval: number | false = false) {
  return useQuery({
    queryKey: ["detail", id],
    queryFn: () => api.detail(id!),
    enabled: id != null,
    // Poll while the detail page is open so volunteered telemetry (status +
    // versions, reported on the agent's own interval) and access info stay
    // fresh without a manual reload. Off by default for one-shot callers.
    refetchInterval,
  })
}

export function useSandboxLogs(id: string | null, tail: number, refetchInterval: number | false) {
  return useQuery({
    queryKey: ["logs", id, tail],
    queryFn: () => api.logs(id!, tail),
    enabled: id != null,
    refetchInterval,
  })
}

/** Create (+ expose) a new detached agent VM. Returns the result so the caller
 *  can open its drawer and show the access info. */
export function useCreateSandbox() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateSandboxIn) => api.create(body),
    onSuccess: (r) => {
      toast.success(`Created ${r.sandbox_id}`)
      // Optimistically add the new VM to the fleet so its /agents/:id route resolves
      // immediately (before the refetch lands); the invalidate then reconciles it
      // with the authoritative row (incl. live metrics).
      qc.setQueryData<FleetEntry[]>(["fleet"], (old) =>
        old?.some((e) => e.sandbox_id === r.sandbox_id)
          ? old
          : [
              ...(old ?? []),
              {
                sandbox_id: r.sandbox_id,
                image: "",
                state: r.state,
                agent_type: r.agent_type,
                created_at: null,
                profile: null,
                tenant: null,
                managed: true,
                metrics: null,
                color: null,
                upgrade_available: false,
                image_version: null,
                desired_state: "running",
                restart_policy: "on-failure",
                restart_count: 0,
                last_restart_at: null,
              },
            ],
      )
      qc.invalidateQueries({ queryKey: ["fleet"] })
    },
    onError: (e) => toast.error(errMsg(e)),
  })
}

// ── Images ────────────────────────────────────────────────────────────────
/** Local agent images (`GET /images`). Polls slowly — the set changes only on a
 *  build or activate. */
export function useImages(refetchInterval: number | false = 15_000) {
  return useQuery({
    queryKey: ["images"],
    queryFn: api.images,
    refetchInterval,
    retry: (failureCount, error) => !isAuthError(error) && failureCount < 3,
  })
}

/** Per-runtime build signal (`GET /images/status`): server-computed
 *  `build_available` + the from→to versions. The server owns the semver, so the
 *  UI renders booleans + strings instead of comparing versions client-side. */
export function useImageStatus(refetchInterval: number | false = 15_000) {
  return useQuery({
    queryKey: ["image-status"],
    queryFn: api.imageStatus,
    refetchInterval,
    retry: (failureCount, error) => !isAuthError(error) && failureCount < 3,
  })
}

/** Poll one build job while it runs (fast), then stop. Drives the live log. */
export function useBuildJob(jobId: string | null) {
  return useQuery({
    queryKey: ["build", jobId],
    queryFn: () => api.build(jobId!),
    enabled: jobId != null,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1500 : false),
  })
}

/** Kick off an image build. Returns the job so the caller can poll it. */
export function useStartBuild() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: BuildImageIn) => api.startBuild(body),
    onSuccess: () => toast.success("Build started"),
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["images"] }),
  })
}

/** Upgrade an agent to the newest image in place (lossless recreate). Refreshes
 *  the fleet + detail so the new versions surface once the agent reports in. */
export function useUpgradeSandbox() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.upgrade(id),
    onSuccess: (r) => {
      toast.success(`Upgrading ${r.sandbox_id}…`)
      qc.invalidateQueries({ queryKey: ["fleet"] })
      qc.invalidateQueries({ queryKey: ["detail", r.sandbox_id] })
    },
    onError: (e) => toast.error(errMsg(e)),
  })
}

/** Re-point the floating active tag at an existing image (rollback / promote). */
export function useActivateImage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (tag: string) => api.activateImage(tag),
    onSuccess: (_r, tag) => {
      toast.success(`Active image → ${tag}`)
      qc.invalidateQueries({ queryKey: ["images"] })
    },
    onError: (e) => toast.error(errMsg(e)),
  })
}

/** start / stop / destroy mutations that refresh the fleet + detail views. */
export function useFleetActions() {
  const qc = useQueryClient()
  const refresh = (id?: string) => {
    qc.invalidateQueries({ queryKey: ["fleet"] })
    if (id) qc.invalidateQueries({ queryKey: ["detail", id] })
  }

  const start = useMutation({
    mutationFn: api.start,
    onSuccess: (r) => {
      toast.success(`Started ${r.sandbox_id}`)
      refresh(r.sandbox_id)
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const stop = useMutation({
    mutationFn: api.stop,
    onSuccess: (r) => {
      toast.success(`Stopped ${r.sandbox_id}`)
      refresh(r.sandbox_id)
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const restart = useMutation({
    mutationFn: api.restart,
    onSuccess: (r) => {
      toast.success(`Restarted ${r.sandbox_id}`)
      refresh(r.sandbox_id)
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const destroy = useMutation({
    mutationFn: api.destroy,
    onSuccess: (_r, id) => {
      toast.success(`Destroyed ${id}`)
      refresh(id)
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  // Recolour is optimistic: the swatch updates instantly, then reconciles (no
  // toast — the change is visually obvious). Rolls back the fleet cache on error.
  const setColor = useMutation({
    mutationFn: ({ id, color }: { id: string; color: string }) => api.setColor(id, color),
    onMutate: async ({ id, color }) => {
      await qc.cancelQueries({ queryKey: ["fleet"] })
      const prev = qc.getQueryData<FleetEntry[]>(["fleet"])
      qc.setQueryData<FleetEntry[]>(["fleet"], (old) =>
        old?.map((e) => (e.sandbox_id === id ? { ...e, color } : e)),
      )
      return { prev }
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["fleet"], ctx.prev)
      toast.error(errMsg(e))
    },
    onSettled: (_r, _e, { id }) => refresh(id),
  })

  // Change the reconciler's restart policy. Optimistic on both the fleet row and
  // the open detail, with a toast (it's a meaningful behavioural setting).
  const setRestartPolicy = useMutation({
    mutationFn: ({ id, policy }: { id: string; policy: string }) =>
      api.setRestartPolicy(id, policy),
    onMutate: async ({ id, policy }) => {
      await qc.cancelQueries({ queryKey: ["fleet"] })
      const prev = qc.getQueryData<FleetEntry[]>(["fleet"])
      qc.setQueryData<FleetEntry[]>(["fleet"], (old) =>
        old?.map((e) => (e.sandbox_id === id ? { ...e, restart_policy: policy } : e)),
      )
      qc.setQueryData<SandboxDetail>(["detail", id], (old) =>
        old ? { ...old, restart_policy: policy } : old,
      )
      return { prev }
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["fleet"], ctx.prev)
      toast.error(errMsg(e))
    },
    onSuccess: (r) => toast.success(`Restart policy: ${r.restart_policy}`),
    onSettled: (_r, _e, { id }) => refresh(id),
  })

  return { start, stop, restart, destroy, setColor, setRestartPolicy }
}

// ── Guest env (the user layer) ─────────────────────────────────────────────
// Never polled: a refetch under a half-typed draft would clobber it.
export function useAgentEnv(id: string | null) {
  return useQuery({
    queryKey: ["env", id],
    queryFn: () => api.env(id!),
    enabled: id != null,
    retry: (failureCount, error) => !isAuthError(error) && failureCount < 3,
  })
}

const envApplyMessage = (r: EnvApplyResult): string => {
  if (!r.changed) return "No changes to apply"
  if (r.takes_effect === "on_next_start")
    return `Saved - ${r.sandbox_id} picks it up the next time it starts`
  return r.applied === "recreate"
    ? `Saved - recreating ${r.sandbox_id}…`
    : `Saved - restarting ${r.sandbox_id}…`
}

/** Write an env diff (`PATCH /fleet/{id}/env`) and apply it. */
export function useEnvActions(id: string) {
  const qc = useQueryClient()

  // Never optimistic: an onMutate would write plaintext into the query cache.
  const save = useMutation({
    mutationFn: (body: EnvPatchIn) => api.patchEnv(id, body),
    onSuccess: (r) => {
      toast.success(envApplyMessage(r))
      // The response omits editable / apply_modes, so merge, don't replace.
      qc.setQueryData<AgentEnv>(["env", id], (old) =>
        old ? { ...old, vars: r.vars, state: r.state } : old,
      )
      qc.invalidateQueries({ queryKey: ["env", id] })
      qc.invalidateQueries({ queryKey: ["fleet"] })
      qc.invalidateQueries({ queryKey: ["detail", id] })
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  // TanStack keeps `variables` on a settled mutation - drop the plaintext.
  useEffect(() => {
    if (save.isSuccess || save.isError) save.reset()
  }, [save])

  return { save }
}

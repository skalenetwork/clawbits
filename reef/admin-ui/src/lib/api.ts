// Typed client for the Reef admin/fleet API. Shapes mirror reef/api/schemas.py.
// In dev the Vite proxy forwards /api/* -> the Reef API (see vite.config.ts).

export type SandboxState = "creating" | "running" | "stopped" | "failed" | "destroyed"

export interface Metrics {
  name: string
  cpu_percent: number
  memory_bytes: number
  memory_limit_bytes: number
  disk_read_bytes: number
  disk_write_bytes: number
  net_rx_bytes: number
  net_tx_bytes: number
  uptime_secs: number
}

export interface FleetEntry {
  sandbox_id: string
  image: string
  state: SandboxState
  agent_type: string
  created_at: string | null
  profile: string | null
  tenant: string | null
  managed: boolean
  metrics: Metrics | null
  /** Operator-chosen dashboard accent; null ⇒ agent-type default. */
  color: string | null
  /** Version-based upgrade signal (server-computed): the agent's reported running
   *  versions vs the active image's baked versions for its runtime. `image_version`
   *  is the truthful "what's running" stack string (oc<oc>-pl<pl> / ic<ic>-ch<ch>),
   *  null until the agent reports; `upgrade_available` ⇒ strictly behind. */
  upgrade_available: boolean
  image_version: string | null
  /** Self-healing (managed only): operator intent, restart policy, and crash-loop stats. */
  desired_state: string | null
  restart_policy: string | null
  restart_count: number
  last_restart_at: string | null
}

export interface AccessInfo {
  kind: string
  url: string | null
  password: string | null
  /** Scoped web-terminal URL (shares the same password). Null when no terminal. */
  terminal_url: string | null
}

export interface NetworkPolicy {
  enabled: boolean
  default_egress: string
  default_ingress: string
  egress_allow: string[]
}

export interface Mount {
  source: string
  dest: string
  type: string
  readonly: boolean
}

export interface SandboxDetail {
  sandbox_id: string
  image: string
  state: SandboxState
  agent_type: string
  cpus: number | null
  memory_mib: number | null
  command: string | null
  env: Record<string, string>
  network: NetworkPolicy
  mounts: Mount[]
  profile: string | null
  tenant: string | null
  created_at: string | null
  updated_at: string | null
  managed: boolean
  port: number | null
  url: string | null
  /** Operator-chosen dashboard accent; null ⇒ agent-type default. */
  color: string | null
  /** Version-based upgrade signal — see FleetEntry. */
  upgrade_available: boolean
  image_version: string | null
  desired_state: string | null
  restart_policy: string | null
  restart_count: number
  last_restart_at: string | null
  access: AccessInfo | null
  status: AgentStatus | null
}

/** Reconciler restart policies (mirrors reef.runtime.RestartPolicy). */
export const RESTART_POLICIES = ["always", "on-failure", "never"] as const
export type RestartPolicy = (typeof RESTART_POLICIES)[number]

/** Agent-volunteered telemetry (read host-side from the status mount). Extensible
 *  — versions today, more later. `null` when the agent hasn't reported. */
export interface AgentStatus {
  schema?: number
  reportedAt?: string
  agent?: string
  versions?: {
    image?: string | null
    openclaw?: string | null
    clawbitsPlugin?: string | null
    ironclaw?: string | null
    clawbitsChannel?: string | null
    hermes?: string | null
  }
}

export interface CreateSandboxIn {
  type: string
  name?: string
  cpus?: number
  memory_mib?: number
  /** Boot a specific image tag (e.g. "reef-oc:0.9.2") instead of the type's
   *  active image. Must be an image whose agent_type === `type`. Omit ⇒ active. */
  image?: string
  /** OpenClaw/Hermes: wire the new VM to a Clawbits org. `clawbits_url` is required
   *  when `org_id` is set. `signup_token` is a one-time `human-…` token from the
   *  Clawbits "Add agent" prompt; the agent enrolls on boot with no approval. */
  org_id?: string
  clawbits_url?: string
  signup_token?: string
  /** Optional provider values, injected under their guest env vars (the
   *  runtimes read them natively; IronClaw's ollama spelling is mapped by its
   *  profile). `ollama_host` must be a plain http(s) URL — no user:pass@. */
  openai_api_key?: string
  anthropic_api_key?: string
  gemini_api_key?: string
  nearai_api_key?: string
  openrouter_api_key?: string
  ollama_host?: string
  /** Which reef-level (REEF_*) provider value to forward: a provider id from
   *  GET /providers, or "none". Omitted: all configured reef-level API keys
   *  (endpoint-kind is never forwarded implicitly). The explicit fields above
   *  always win for their provider. */
  provider?: string
  /** Per-agent default model (→ REEF_DEFAULT_MODEL, fresh boot only). Bare id
   *  (e.g. "gemini-3.5-flash", "llama3.2"); REQUIRED for ollama (422 without). */
  model?: string
  /** Self-healing policy for the reconciler: always | on-failure | never (default on-failure). */
  restart_policy?: string
  /** Custom guest env baked into the new VM (lowest precedence — reef-managed
   *  wiring always wins). Reef-managed keys (CLAWBITS_*, gateway/model keys) and
   *  the REEF_* prefix are rejected with a 422. Never persisted by reef. */
  env?: Record<string, string>
}

export interface CreateSandboxResult {
  sandbox_id: string
  state: SandboxState
  agent_type: string
  access: AccessInfo | null
}

export interface Logs {
  sandbox_id: string
  lines: string[]
}

export interface Health {
  status: string
  msb_available: boolean
  sandboxes: number | null
}

export interface LatestVersion {
  latest: string | null
  source: string | null
}

export interface ActionResult {
  sandbox_id: string
  state: SandboxState
}

/** One AI provider this Reef can wire into an agent VM (`GET /providers`).
 *  `configured` reports ONLY that a reef-level value (REEF_*) is set - the
 *  value never crosses the wire. */
export interface ProviderInfo {
  id: string
  label: string
  configured: boolean
  /** "api_key" (secret) | "endpoint" (a URL, e.g. ollama — the picker asks for
   *  a host instead of a key, and must also collect a model). */
  kind: string
  /** Agent types whose images can consume this provider. */
  runtimes: string[]
}

export interface ProvidersResult {
  providers: ProviderInfo[]
  /** Create-API capability flags (e.g. "env"); absent on older Reefs. The
   *  admin-ui ships with reef so it doesn't gate on this — clawbits does. */
  features?: string[]
}

/** One model in OpenRouter's live catalog (public listing, reef-proxied —
 *  `GET /providers/openrouter/models`). `id` is the vendor/model slug the
 *  create's `model` field takes. */
export interface OpenRouterModel {
  id: string
  name?: string | null
  context_length?: number | null
}

/** Operator-adjustable settings (`GET /settings`). Today: the public URL agent
 *  surface links (Control UI / terminal) are built on. `override` (settings.json)
 *  wins over `env` (REEF_PUBLIC_URL); `effective` is what's actually used (null ⇒
 *  the request origin at call time). */
export interface SettingsResult {
  public_url_override: string | null
  public_url_env: string | null
  public_url_effective: string | null
}

/** One local agent image (`GET /images`). Mirrors reef.api.schemas.ImageOut. */
export interface ImageInfo {
  tag: string
  image_id: string
  created_at: string | null
  size_bytes: number
  /** Which runtime this image is for (openclaw | ironclaw) - the create wizard
   *  filters image choices by the picked agent type. */
  agent_type: string
  /** Baked LABELs; null on images built before they were added. `runtime_version`
   *  is the engine (openclaw | ironclaw), `component_version` the clawbits piece
   *  (plugin | channel). */
  reef_image_version: string | null
  runtime_version: string | null
  component_version: string | null
  /** This image is what new agents (and upgrades) of its type boot. */
  is_active: boolean
}

/** Build inputs (`POST /images/builds`). runtime/component overrides apply to
 *  OpenClaw only; IronClaw derives its engine/channel versions from source. */
export interface BuildImageIn {
  /** Which runtime to build (openclaw | ironclaw). Default openclaw. */
  agent_type?: string
  /** Override the pinned engine base tag (OpenClaw only; true "latest openclaw"). */
  runtime_version?: string
  /** Pin the baked clawbits plugin (OpenClaw only); omit to resolve latest. */
  component_version?: string
  /** Full --no-cache rebuild; default false = smart cache (base cached, plugin re-resolved). */
  force_fresh?: boolean
}

export type BuildStatus = "running" | "succeeded" | "failed"

/** An image-build job (`GET /images/builds/{id}`). */
export interface BuildJob {
  id: string
  status: BuildStatus
  error: string | null
  started_at: string
  finished_at: string | null
  agent_type: string
  runtime_version: string | null
  component_version: string | null
  log: string[]
}

/** One runtime's build signal (`GET /images/status`): the active image's baked
 *  versions joined with the latest floors + a server-computed `build_available`. */
export interface RuntimeImageStatus {
  agent_type: string
  active_runtime_version: string | null
  active_component_version: string | null
  latest_runtime: LatestVersion
  latest_component: LatestVersion
  build_available: boolean
}

/** Per-runtime build availability (`GET /images/status`). The server owns the
 *  semver; the UI renders the boolean + the from→to versions. */
export interface ImageStatus {
  enabled: boolean
  fetched_at: string | null
  runtimes: RuntimeImageStatus[]
}

const BASE = import.meta.env.VITE_REEF_API_URL ?? "/api"

// ── Admin token ─────────────────────────────────────────────────────────────
// When the Reef runs with REEF_ADMIN_TOKEN set, the operator pastes it once
// into the auth dialog (App.tsx). It's kept per-tab in sessionStorage so a
// reload doesn't re-prompt, and only ever leaves the browser as the
// Authorization header to the Reef itself. A build-time VITE_REEF_ADMIN_TOKEN
// still works as a seed for kiosk-style deployments.
const TOKEN_KEY = "reef-admin-token"

const _seed =
  (import.meta.env.VITE_REEF_ADMIN_TOKEN as string | undefined) ??
  sessionStorage.getItem(TOKEN_KEY) ??
  ""
let _token: string | null = _seed.trim().length > 0 ? _seed.trim() : null

export function setAdminToken(token: string | null): void {
  const t = (token ?? "").trim()
  _token = t.length > 0 ? t : null
  try {
    if (_token) sessionStorage.setItem(TOKEN_KEY, _token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable (private mode) — token still works in-memory */
  }
}

export const hasAdminToken = (): boolean => _token !== null

/** Reef rejected (or is missing) the admin token — the UI shows the auth dialog. */
export const isAuthError = (e: unknown): e is ApiError =>
  e instanceof ApiError && (e.status === 401 || e.status === 403)

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (_token) headers.set("Authorization", `Bearer ${_token}`)

  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers })
  } catch {
    throw new ApiError(0, "Can't reach the Reef API — is it running? (uv run python -m reef.api)")
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const enc = encodeURIComponent

export const api = {
  health: () => req<Health>("/healthz"),
  providers: () => req<ProvidersResult>("/providers"),
  openrouterModels: () => req<{ models: OpenRouterModel[] }>("/providers/openrouter/models"),
  settings: () => req<SettingsResult>("/settings"),
  updateSettings: (public_url: string | null) =>
    req<SettingsResult>("/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public_url }),
    }),
  fleet: (state?: SandboxState) => req<FleetEntry[]>(`/fleet${state ? `?state=${state}` : ""}`),
  create: (body: CreateSandboxIn) =>
    req<CreateSandboxResult>("/fleet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  detail: (id: string) => req<SandboxDetail>(`/fleet/${enc(id)}`),
  // Re-reveal an exposed agent's access secret (URL + password). `detail` never
  // returns the password (one-time reveal at create); this admin endpoint reads
  // it back from the running guest so an operator who lost it can recover it.
  // POST (its response carries a secret — never cache it). 404s when the agent
  // isn't exposed.
  reveal: (id: string) => req<AccessInfo>(`/fleet/${enc(id)}/reveal`, { method: "POST" }),
  logs: (id: string, tail = 200) => req<Logs>(`/fleet/${enc(id)}/logs?tail=${tail}`),
  start: (id: string) => req<ActionResult>(`/fleet/${enc(id)}/start`, { method: "POST" }),
  stop: (id: string) => req<ActionResult>(`/fleet/${enc(id)}/stop`, { method: "POST" }),
  restart: (id: string) => req<ActionResult>(`/fleet/${enc(id)}/restart`, { method: "POST" }),
  upgrade: (id: string) => req<ActionResult>(`/fleet/${enc(id)}/upgrade`, { method: "POST" }),
  destroy: (id: string) => req<void>(`/fleet/${enc(id)}`, { method: "DELETE" }),
  setColor: (id: string, color: string) =>
    req<{ sandbox_id: string; color: string | null }>(`/fleet/${enc(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color }),
    }),
  setRestartPolicy: (id: string, restart_policy: string) =>
    req<{ sandbox_id: string; color: string | null; restart_policy: string | null }>(
      `/fleet/${enc(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ restart_policy }),
      },
    ),
  // ── Images ──
  images: () => req<ImageInfo[]>("/images"),
  imageStatus: () => req<ImageStatus>("/images/status"),
  startBuild: (body: BuildImageIn) =>
    req<BuildJob>("/images/builds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  build: (jobId: string) => req<BuildJob>(`/images/builds/${enc(jobId)}`),
  activateImage: (tag: string) =>
    req<void>("/images/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag }),
    }),
}

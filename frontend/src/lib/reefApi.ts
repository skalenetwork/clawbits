// Browser-DIRECT client for a self-hosted Reef API, reached over the owner's
// own tunnel. clawbits' backend is deliberately NOT in this path: the browser
// talks to Reef itself, presenting an admin token the operator enters PER
// SESSION. That token is kept in sessionStorage (per-tab) so it survives a page
// reload, but is wiped when the tab/window closes — and it is NEVER written to
// localStorage or a cookie, and never sent to clawbits (so a clawbits-side
// breach can't reach anyone's Reef, and the token leaves no trace on disk once
// the tab is gone).
//
// Shapes mirror reef/api/schemas.py; we keep only the fields the UI renders.

const TOKEN_STORAGE_KEY = "reef.adminToken"

/** sessionStorage access wrapped because it can throw (privacy mode, storage
 *  disabled, SSR) — there we silently degrade to in-memory-only for the tab. */
function readStoredToken(): string | null {
  try {
    const t = sessionStorage.getItem(TOKEN_STORAGE_KEY)
    return t && t.length > 0 ? t : null
  } catch {
    return null
  }
}

// Hydrate from sessionStorage on load so the token survives a reload in-tab.
let _token: string | null = readStoredToken()

export function setReefToken(token: string | null): void {
  const t = (token ?? "").trim()
  _token = t.length > 0 ? t : null
  try {
    if (_token) sessionStorage.setItem(TOKEN_STORAGE_KEY, _token)
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    /* storage unavailable — keep the in-memory value for this tab */
  }
}
export function getReefToken(): string | null {
  return _token
}
export function hasReefToken(): boolean {
  return _token !== null
}

/** Reef rejected (or is missing) the admin token — distinct from a transport
 *  failure so the UI can prompt to re-enter the token rather than "Reef down". */
export class ReefAuthError extends Error {
  constructor(message = "Reef rejected the admin token") {
    super(message)
    this.name = "ReefAuthError"
  }
}

/** Reef couldn't be reached at all (tunnel down, wrong URL, CORS, offline). */
export class ReefUnreachableError extends Error {
  constructor(message = "Can't reach Reef - is the tunnel up and the URL correct?") {
    super(message)
    this.name = "ReefUnreachableError"
  }
}

/** A 409 from `POST /images/builds` — reef builds one image at a time. Distinct
 *  so the UI can offer to attach to the in-flight job instead of erroring. */
export class ReefBuildInProgressError extends Error {
  constructor(message = "A build is already running") {
    super(message)
    this.name = "ReefBuildInProgressError"
  }
}

/** Any other non-OK Reef response, carrying the HTTP status so callers can map
 *  it to friendly copy (e.g. 404/422 ⇒ "no longer managed", 502 ⇒ "runtime
 *  unavailable"). `message` is reef's own `detail` when present. Extends Error,
 *  so existing `e instanceof Error ? e.message` handling still works. */
export class ReefRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "ReefRequestError"
    this.status = status
  }
}

export interface ReefHealth {
  status: string
  msb_available: boolean
  sandboxes: number | null
}

export interface ReefMetrics {
  cpu_percent: number
  memory_bytes: number
  memory_limit_bytes: number
  uptime_secs: number
}

export type ReefState = "creating" | "running" | "stopped" | "failed" | "destroyed"

export interface ReefFleetEntry {
  sandbox_id: string
  image: string
  state: ReefState
  agent_type: string
  created_at: string | null
  managed: boolean
  metrics: ReefMetrics | null
  /** Operator-chosen dashboard accent (reef AGENT_COLORS); null ⇒ default. */
  color?: string | null
  restart_policy?: string | null
  /** Version-based upgrade signal (server-computed): the agent's reported running
   *  versions vs the active image's baked versions for its runtime. `image_version`
   *  is the truthful "what's running" stack string (oc<oc>-pl<pl> / ic<ic>-ch<ch>),
   *  null until the agent reports; `upgrade_available` ⇒ strictly behind. */
  upgrade_available?: boolean
  image_version?: string | null
}

export interface ReefAccessInfo {
  kind: string
  url: string | null
  password: string | null
  terminal_url: string | null
}

/** Agent-volunteered version telemetry — the guest writes a secret-free
 *  status.json that reef reads host-side. Any field is null until the (running)
 *  agent reports it. */
export interface ReefAgentVersions {
  image?: string | null
  openclaw?: string | null
  clawbitsPlugin?: string | null
  ironclaw?: string | null
  clawbitsChannel?: string | null
  /** Hermes carries the clawbits *plugin* (not a channel), so it reports its own
   *  engine version alongside `clawbitsPlugin`. */
  hermes?: string | null
}

export interface ReefAgentStatus {
  reportedAt?: string | null
  agent?: string | null
  versions?: ReefAgentVersions | null
}

export interface ReefSandboxDetail {
  sandbox_id: string
  image?: string
  state: ReefState
  agent_type: string
  url: string | null
  access: ReefAccessInfo | null
  cpus?: number | null
  memory_mib?: number | null
  created_at?: string | null
  updated_at?: string | null
  color?: string | null
  restart_policy?: string | null
  restart_count?: number
  /** Version-based upgrade signal — see ReefFleetEntry. */
  upgrade_available?: boolean
  image_version?: string | null
  /** Volunteered telemetry (versions, reportedAt); null when unreported. */
  status?: ReefAgentStatus | null
}

const stripSlash = (u: string) => u.replace(/\/+$/, "")

async function reefReq<T>(
  baseUrl: string,
  path: string,
  opts: { auth?: boolean; method?: string; body?: unknown } = {},
): Promise<T> {
  const headers = new Headers()
  if (opts.auth) {
    if (!_token) throw new ReefAuthError("Reef admin token required")
    headers.set("Authorization", `Bearer ${_token}`)
  }
  if (opts.body !== undefined) headers.set("Content-Type", "application/json")
  let res: Response
  try {
    res = await fetch(`${stripSlash(baseUrl)}${path}`, {
      method: opts.method ?? "GET",
      headers,
      mode: "cors",
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    throw new ReefUnreachableError()
  }
  if (res.status === 401 || res.status === 403) throw new ReefAuthError()
  if (!res.ok) {
    let detail = `Reef error ${String(res.status)}`
    try {
      const body = (await res.json()) as { detail?: unknown }
      if (typeof body.detail === "string") detail = body.detail
    } catch {
      /* non-JSON body */
    }
    // The only 409 in the reef API is "a build is already running" — surface it
    // distinctly so the build UI can attach to the live job rather than error.
    if (res.status === 409) throw new ReefBuildInProgressError(detail)
    throw new ReefRequestError(res.status, detail)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Liveness + runtime reachability. Unauthenticated — used to validate a pasted
 *  URL at connect time and to show an online/offline badge. */
export const reefHealth = (baseUrl: string) => reefReq<ReefHealth>(baseUrl, "/healthz")

/** The fleet list (requires the session admin token). */
export const reefFleet = (baseUrl: string) => reefReq<ReefFleetEntry[]>(baseUrl, "/fleet", { auth: true })

/** One agent's detail — carries the `access` reveal (URL + derived secret) used
 *  to open the Control UI / terminal pre-authenticated. */
export const reefDetail = (baseUrl: string, id: string) =>
  reefReq<ReefSandboxDetail>(baseUrl, `/fleet/${encodeURIComponent(id)}`, { auth: true })

/** Re-reveal an exposed agent's access secret (surface URL + password). Reef
 *  mints the dashboard/gateway password ONCE at creation and `reefDetail` never
 *  returns it again — this admin endpoint reads it back out of the running
 *  guest's env so an operator who lost it can recover it without recreating the
 *  agent. POST (its response carries a secret; never cache it). 404s when the
 *  agent isn't exposed or its type has no revealable secret. */
export const reefReveal = (baseUrl: string, id: string) =>
  reefReq<ReefAccessInfo>(baseUrl, `/fleet/${encodeURIComponent(id)}/reveal`, {
    auth: true,
    method: "POST",
  })

export interface ReefCreateBody {
  type: string
  /** Boot a specific image tag (from GET /images) instead of the type's active
   *  image. Must be an image whose agent_type === `type`. Omit ⇒ active image. */
  image?: string
  name?: string
  org_id?: string
  clawbits_url?: string
  signup_token?: string
  openai_api_key?: string
  anthropic_api_key?: string
  gemini_api_key?: string
  nearai_api_key?: string
  openrouter_api_key?: string
  /** Ollama server URL (plain http(s), no user:pass@). Host-local values are
   *  normalized by the Reef for its runtime and allowed through egress. */
  ollama_host?: string
  /** Opt-in capabilities (reef/capabilities.py): "gh" | "cron". Omit/[] => the
   *  safe baseline. Only send when GET /providers `features` includes
   *  "capabilities" - an older reef drops unknown fields silently, which would
   *  create an agent less capable than the wizard claimed. */
  capabilities?: string[]
  /** Which reef-level (REEF_*) provider value the VM gets: a provider id from
   *  GET /providers, or "none". Omitted: all configured reef-level API keys
   *  (legacy behavior). The explicit fields above always win. */
  provider?: string
  /** Per-agent default model (bare id, e.g. "gemini-3.5-flash"). REQUIRED for
   *  ollama (the Reef 422s without one). Only send when the Reef advertises
   *  the "model" feature — an older Reef silently drops the field. */
  model?: string
  cpus?: number
  memory_mib?: number
  restart_policy?: string
  /** Custom guest env baked into the new VM. Reef-managed keys (CLAWBITS_*,
   *  gateway/model keys) and the REEF_* prefix are rejected with a 422. Only
   *  send when the Reef advertises the "env" feature (ReefProvidersResult) —
   *  an older Reef would silently drop the field. */
  env?: Record<string, string>
}

export interface ReefCreateResult {
  sandbox_id: string
  state: ReefState
  agent_type: string
  access: ReefAccessInfo | null
}

/** Create + expose a new agent VM (requires the session admin token). clawbits
 *  mints the one-time signup token; Reef boots the VM and the agent enrolls. */
export const reefCreate = (baseUrl: string, body: ReefCreateBody) =>
  reefReq<ReefCreateResult>(baseUrl, "/fleet", { auth: true, method: "POST", body })

/** One AI provider the Reef can wire into an agent VM (`GET /providers`).
 *  `configured` reports ONLY that a reef-level value (REEF_*) is set on the
 *  Reef host - the value itself never crosses the wire. */
export interface ReefProvider {
  id: string
  label: string
  configured: boolean
  /** "api_key" (secret key) | "endpoint" (a URL, e.g. ollama — the picker asks
   *  for a host instead of a key and must also collect a model). Absent on an
   *  older Reef ⇒ treat as "api_key". */
  kind?: string
  /** Agent types whose images can consume this provider. Absent ⇒ all. */
  runtimes?: string[]
}

export interface ReefProvidersResult {
  providers: ReefProvider[]
  /** Create-API capability flags (e.g. "env"). Absent on older Reefs — treat
   *  as "none" and hide the matching UI instead of silently dropping input. */
  features?: string[]
}

/** Which AI providers the Reef offers (admin-gated - it reveals deployment
 *  config). Drives the "Add agent" provider picker. 404s on an older Reef;
 *  the dialog treats any failure as "availability unknown" and falls back to
 *  the raw key fields. */
export const reefProviders = (baseUrl: string) =>
  reefReq<ReefProvidersResult>(baseUrl, "/providers", { auth: true })

/** One model pulled on the probed Ollama server. `id` is the ollama tag —
 *  exactly what the create's `model` field takes. */
export interface ReefOllamaModel {
  id: string
  size?: number | null
  parameter_size?: string | null
}

/** The models an Ollama server has actually pulled, probed REEF-side (the
 *  browser usually can't reach the host — guest aliases, reef-box loopback,
 *  LAN). Omit `host` to probe the maintainer's REEF_OLLAMA_HOST. 422 = no/bad
 *  host, 502 = server unreachable. */
export const reefOllamaModels = (baseUrl: string, host?: string) =>
  reefReq<{ models: ReefOllamaModel[] }>(
    baseUrl,
    `/providers/ollama/models${host ? `?host=${encodeURIComponent(host)}` : ""}`,
    { auth: true },
  )

/** One model in OpenRouter's live catalog (public listing, proxied REEF-side).
 *  `id` is the vendor/model slug — exactly what the create's `model` takes. */
export interface ReefOpenRouterModel {
  id: string
  name?: string | null
  context_length?: number | null
}

/** OpenRouter's full model catalog, fetched REEF-side (mirrors the ollama
 *  probe: one admin-gated surface, no per-browser CORS story). 502 =
 *  openrouter.ai unreachable; 404 = an older Reef without the proxy — the
 *  picker degrades to the curated pills + free text either way. */
export const reefOpenRouterModels = (baseUrl: string) =>
  reefReq<{ models: ReefOpenRouterModel[] }>(baseUrl, "/providers/openrouter/models", {
    auth: true,
  })

/** Open the OpenClaw Control UI pre-authenticated via the gateway's native
 *  `#token=` fragment (client-only — never sent to the server). Mirrors
 *  reef/admin-ui's controlUiAuthUrl. */
export function controlUiAuthUrl(url: string, token: string | null): string {
  if (!token) return url
  return `${stripSlash(url)}/#token=${encodeURIComponent(token)}`
}

/** Open the web terminal with the ttyd basic-auth creds embedded (username is
 *  fixed by the image entrypoint: `--credential "reef:…"`), so the browser sends
 *  the `Authorization` header and never shows its native auth prompt — the same
 *  one-step experience as the Control UI's `#token=`. The surface proxy forwards
 *  `Authorization` to ttyd, so this works over the https tunnel as well as local
 *  http. Use ONLY for the open action — the displayed/copied URL must stay the
 *  clean form (the password is in the userinfo here). Mirrors reef/admin-ui's
 *  terminalAuthUrl. */
export function terminalAuthUrl(url: string, password: string | null): string {
  if (!password) return url
  const sep = url.indexOf("://")
  const scheme = sep < 0 ? "" : url.slice(0, sep + 3)
  if (scheme !== "http://" && scheme !== "https://") return url
  return `${scheme}reef:${encodeURIComponent(password)}@${url.slice(sep + 3)}`
}

/** Pre-authenticated "open" URL for an agent's PRIMARY web surface, by agent
 *  kind (`access.kind` from the reef detail/create). OpenClaw/IronClaw's
 *  Control UI reads a `#token=` fragment; Hermes' dashboard sits behind reef's
 *  nginx basic-auth proxy (username `reef`, same secret as the terminal), where
 *  a `#token=` fragment would just land on the browser's 401 prompt — embed the
 *  creds instead, terminal-style. Mirrors reef/admin-ui's surfaceAuthUrl. */
export function surfaceAuthUrl(
  kind: string | null | undefined,
  url: string,
  secret: string | null,
): string {
  return kind === "hermes" ? terminalAuthUrl(url, secret) : controlUiAuthUrl(url, secret)
}

// ── Images · builds · versions · upgrade ─────────────────────────────────────
// The image axis (fleet-global, per runtime): a build of a newer engine /
// clawbits component produces a fresh image that becomes what new agents boot
// (server `build_available`, GET /images/status). The VM axis (per-agent): a VM
// is upgradeable when its REPORTED versions are behind the active image's baked
// versions (server `upgrade_available`). Shapes mirror reef/api/schemas.py.

/** One local agent image (`GET /images`). `is_active` ⇒ what new agents + the
 *  upgrade path boot. Baked label versions are null on pre-label images. */
export interface ReefImage {
  tag: string
  image_id: string
  created_at: string | null
  size_bytes: number
  reef_image_version: string | null
  /** Baked LABELs: `runtime_version` is the engine (openclaw | ironclaw),
   *  `component_version` the clawbits piece (plugin | channel). Null pre-label. */
  runtime_version: string | null
  component_version: string | null
  is_active: boolean
  /** Which runtime this image is: "openclaw" | "ironclaw" | "hermes". Older reefs
   *  (pre multi-agent-type) omit it ⇒ treat as "openclaw". */
  agent_type?: string
}

/** Build inputs (`POST /images/builds`). runtime/component overrides apply to
 *  OpenClaw only; IronClaw derives its engine/channel versions from source, and
 *  Hermes from its base image + the in-tree plugin. */
export interface ReefBuildBody {
  /** Which runtime to build ("openclaw" | "ironclaw" | "hermes"). Default openclaw. */
  agent_type?: string
  /** Override the pinned engine base tag (OpenClaw only); omit ⇒ Dockerfile default. */
  runtime_version?: string
  /** Pin the baked clawbits plugin (OpenClaw only); omit ⇒ resolve latest. */
  component_version?: string
  /** Full --no-cache rebuild; default false = smart cache (base cached, plugin re-resolved). */
  force_fresh?: boolean
}

export type ReefBuildStatus = "running" | "succeeded" | "failed"

/** An image-build job (`GET /images/builds/{id}`). Jobs live in reef's memory,
 *  so a reef restart 404s the job even when the image finished building. */
export interface ReefBuildJob {
  id: string
  status: ReefBuildStatus
  error: string | null
  started_at: string
  finished_at: string | null
  agent_type: string
  runtime_version: string | null
  component_version: string | null
  log: string[]
}

export interface ReefLatestVersion {
  latest: string | null
  source: string | null
}

/** Latest floors for one runtime: the engine + the clawbits component. */
export interface ReefRuntimeLatest {
  runtime: ReefLatestVersion
  component: ReefLatestVersion
}

/** Latest available versions per runtime (`GET /versions/latest`, unauth,
 *  best-effort). IronClaw's floors are null (engine self-built; channel ships
 *  in-tree) until clawbits exposes a channel floor; Hermes' floors are null
 *  too (engine from the pinned base image; plugin ships in-tree). */
export interface ReefLatestVersions {
  enabled: boolean
  fetched_at: string | null
  openclaw: ReefRuntimeLatest
  ironclaw: ReefRuntimeLatest
  hermes: ReefRuntimeLatest
}

/** One runtime's build signal (`GET /images/status`): the active image's baked
 *  versions joined with the latest floors + a server-computed `build_available`. */
export interface ReefRuntimeImageStatus {
  agent_type: string
  active_runtime_version: string | null
  active_component_version: string | null
  latest_runtime: ReefLatestVersion
  latest_component: ReefLatestVersion
  build_available: boolean
}

/** Per-runtime build availability (`GET /images/status`, authed). The server
 *  owns the semver; the UI renders the boolean + the from→to versions. */
export interface ReefImageStatus {
  enabled: boolean
  fetched_at: string | null
  runtimes: ReefRuntimeImageStatus[]
}

/** Locally-built agent images. */
export const reefImages = (baseUrl: string) => reefReq<ReefImage[]>(baseUrl, "/images", { auth: true })

/** Per-runtime build signal (server-computed build_available + from→to versions). */
export const reefImageStatus = (baseUrl: string) =>
  reefReq<ReefImageStatus>(baseUrl, "/images/status", { auth: true })

/** Start an image build (201). Throws ReefBuildInProgressError on a 409 (one
 *  build at a time) so the caller can attach to the live job via reefBuildJobs. */
export const reefStartBuild = (baseUrl: string, body: ReefBuildBody) =>
  reefReq<ReefBuildJob>(baseUrl, "/images/builds", { auth: true, method: "POST", body })

/** All known build jobs (running + recent) — used to attach to an in-flight
 *  build after a 409 or a page reload. */
export const reefBuildJobs = (baseUrl: string) =>
  reefReq<ReefBuildJob[]>(baseUrl, "/images/builds", { auth: true })

/** Poll one build job (404 once reef evicts/loses it — degrade to refetching
 *  /images, don't treat as a build failure). */
export const reefBuildJob = (baseUrl: string, id: string) =>
  reefReq<ReefBuildJob>(baseUrl, `/images/builds/${encodeURIComponent(id)}`, { auth: true })

/** Re-point the floating active tag at an existing image (rollback / promote).
 *  Affects every newly-created VM fleet-wide — gate behind a confirm. (204) */
export const reefActivateImage = (baseUrl: string, tag: string) =>
  reefReq<void>(baseUrl, "/images/activate", { auth: true, method: "POST", body: { tag } })

/** Recreate one agent VM on the active image in place (lossless: workspace,
 *  clawbits identity, and access password are preserved). */
export const reefUpgrade = (baseUrl: string, id: string) =>
  reefReq<{ sandbox_id: string; state: ReefState }>(
    baseUrl,
    `/fleet/${encodeURIComponent(id)}/upgrade`,
    { auth: true, method: "POST" },
  )

/** Latest available versions (unauthenticated, best-effort). */
export const reefLatestVersions = (baseUrl: string) =>
  reefReq<ReefLatestVersions>(baseUrl, "/versions/latest")

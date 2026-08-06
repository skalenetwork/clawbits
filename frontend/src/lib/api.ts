/** Server-provided reference to an entity's avatar SVG in R2.
 *  See the backend ``clawbits.avatars`` module — the URL is stable per
 *  (entity, version) tuple, immutable for a year, and safe to drop
 *  straight into an ``<img src>``. ``kind`` distinguishes a
 *  deterministically-generated default from a user-uploaded custom one;
 *  the upload UI uses it to decide whether a "reset to default"
 *  affordance is shown. */
export interface AvatarRef {
  url: string;
  version: number;
  kind: "generated" | "uploaded";
}

export interface HumanUser {
  id: number;
  email: string;
  display_name?: string;
  /** Server-stored avatar reference. Always populated by /api/auth/me
   *  for fresh sessions; absent on legacy session payloads. */
  avatar?: AvatarRef | null;
  /** ISO timestamp the user signed up — surfaced on Settings → Profile. */
  created_at?: string | null;
  /** ISO timestamp of the user's most recent presence heartbeat. */
  last_seen_at?: string | null;
}

/** Telegram-style per-signal privacy controls. Each flag gates one
 *  user-visible signal — flip it off to hide that signal from peers
 *  without affecting any of the others. */
export interface PrivacySettings {
  /** When false, the precise ``last_seen_at`` is replaced by a bucketed
   *  string ("Last seen recently" / "within a week" / etc.) in every
   *  peer-visible response. */
  last_seen_visible: boolean;
  /** When false, peers see your presence dot as offline regardless of
   *  your real status (online / idle / offline). */
  online_status_visible: boolean;
  /** When false, suppresses the peer-visible ``member.read`` broadcast
   *  and strips ``last_read_post_id`` from member lists. Your own
   *  unread badge still updates correctly. */
  read_receipts_enabled: boolean;
  /** When false, your "X is typing…" indicator is never broadcast to
   *  other members of the channel. */
  typing_indicators_enabled: boolean;
}

/** The human operator of an agent — surfaced on the agents page so
 *  each agent shows who runs it. */
export interface AgentOperator {
  human_id: number;
  display_name?: string | null;
  avatar?: AvatarRef | null;
}

export interface AgentUser {
  agent_id: string;
  nickname?: string | null;
  display_name?: string | null;
  creation_time?: string | null;
  /** Last heartbeat from the agent's plugin (naive-UTC string), or null when
   *  it has never pinged. Feed it through ``agentLivenessStatus`` /
   *  ``AgentPresenceProvider`` to derive available / offline / setting-up. */
  last_alive_at?: string | null;
  /** The human who operates this agent. Null when unbound. */
  operator?: AgentOperator | null;
  file_count?: number;
  /** Auto-evolving "what people use this agent for" summary, shown on the
   *  agent card. May be a templated default until the agent generates a real
   *  one (generation happens agent-side). */
  description?: string | null;
  /** True while an operator-requested regeneration is pending (the agent hasn't
   *  pushed a fresh description yet). Drives the card's "Refreshing…" state. */
  description_regen_pending?: boolean;
  /** "default" (creation placeholder) | "auto" (agent-generated) | "manual".
   *  Lets the home page nudge operators whose agents still use the default. */
  description_source?: string | null;
  /** When true, this agent can process other agents' messages and tags replies. */
  inter_agent_mode_enabled?: boolean;
  /** When true, the agent stays connected but ignores inbound requests. */
  snoozed?: boolean;
  /** Max consecutive inter-agent turns before requiring human guidance. */
  inter_agent_message_limit?: number;
  /** True when the current viewer is this agent's operator — gates the
   *  home-page "generate description" banner. */
  is_operator?: boolean;
  /** Whether the current viewer may open a DM with this agent. Contact is
   *  closed by default — see ``AgentContactPermission`` server-side. The UI
   *  disables "New DM" / "Message" entry points when false. */
  can_dm?: boolean;
  /** Whether the current viewer may ``@``-tag this agent in a channel. */
  can_tag?: boolean;
  /** Whether the current viewer (operator or org owner) may edit this agent's
   *  contact allowlist — gates the "Who can contact" management panel. */
  can_manage_contacts?: boolean;
  avatar?: AvatarRef | null;
  /** The reef VM (sandbox id) this agent runs in, when it was provisioned via
   *  "Add agent → Run on Reef". Null for self-hosted agents. The reef base URL
   *  is the org's connected Reef (``getReefConnection``). */
  reef_sandbox_id?: string | null;
  /** Runtime kind self-reported by the agent's plugin on its liveness ping
   *  ("openclaw" | "ironclaw" | "hermes"). Null until the first modern ping —
   *  drives the card's type-logo sticker. */
  agent_type?: string | null;
  /** Clawbits plugin version self-reported on the liveness ping (via the
   *  X-Clawbits-Plugin-Version header). Null until the first modern ping —
   *  drives the card's version sticker. */
  plugin_version?: string | null;
}

export interface AgentProfile {
  agent_id: string;
  /** The agent's email address (``{agent_id}@{mail-domain}``), server-computed. */
  email_address?: string | null;
  nickname?: string | null;
  display_name?: string | null;
  bio?: string | null;
  location?: string | null;
  website?: string | null;
  header_url?: string | null;
  creation_time?: string;
  /** Last heartbeat (naive-UTC string) or null when never pinged — drives the
   *  profile hero's availability dot via the presence provider. */
  last_alive_at?: string | null;
  /** The human who operates this agent. Null when unbound. */
  operator?: AgentOperator | null;
  file_count?: number;
  inter_agent_mode_enabled?: boolean;
  /** When true, the agent stays connected but ignores inbound requests. */
  snoozed?: boolean;
  /** Max consecutive inter-agent turns before requiring human guidance. */
  inter_agent_message_limit?: number;
  /** Auto-evolving usage summary + its provenance. Generated agent-side. */
  description?: string | null;
  description_generated_at?: string | null;
  /** "default" (creation placeholder) | "auto" (agent-generated) | "manual". */
  description_source?: string | null;
  /** True while an operator-requested regeneration is pending. */
  description_regen_pending?: boolean;
  /** True when the current viewer is this agent's operator — gates the
   *  "regenerate description" control. */
  is_operator?: boolean;
  /** Whether the current viewer may DM / tag this agent, and whether they may
   *  manage its contact allowlist. Contact is closed by default. */
  can_dm?: boolean;
  can_tag?: boolean;
  can_manage_contacts?: boolean;
  /** LobsterTalk sidecar settings (operator-only). When enabled, a sidecar nudges
   *  the agent about channel conversations that need it. Idle until a model is
   *  set. Host null = the sidecar's local Ollama default. */
  lobstertalk_enabled?: boolean;
  lobstertalk_ollama_host?: string | null;
  lobstertalk_ollama_model?: string | null;
  lobstertalk_interval_seconds?: number;
  lobstertalk_message_limit?: number;
  /** Server-generated bottts avatar (see :class:`AvatarRef`). */
  avatar?: AvatarRef | null;
  /** The reef VM (sandbox id) this agent runs in, when provisioned via "Run on
   *  Reef". Null for self-hosted agents. */
  reef_sandbox_id?: string | null;
  /** Runtime kind self-reported by the agent's plugin ("openclaw" | "ironclaw"
   *  | "hermes"). Null until the first modern liveness ping — drives the card's
   *  type sticker. */
  agent_type?: string | null;
  /** Clawbits plugin version self-reported on the liveness ping. Null until the
   *  first modern ping — drives the card's version sticker. */
  plugin_version?: string | null;
}

export type OrgRole = "owner" | "member";

export interface Org {
  org_id: string;
  name: string;
  display_name?: string;
  is_personal: boolean;
  created_at?: string;
  /** Caller's role in this org. Populated by listing endpoints
   *  (``getOrgs`` / ``getOrg``) so the UI can gate admin surfaces
   *  without needing to fetch the full members list. */
  my_role?: OrgRole | null;
  /** When the caller last activated this org in the UI. ``null`` means
   *  "never visited" — the switcher renders a "New" pill so a
   *  freshly-invited user can tell at a glance that they were added
   *  to an org they haven't entered yet. */
  last_visited_at?: string | null;
  /** Unread posts across the caller's non-muted channels in this org.
   *  Drives the cross-org activity badge in the switcher. */
  unread_count?: number;
  /** Number of channels with at least one unread post (same filters). */
  unread_channel_count?: number;
  /** Org-level opt-in for the LobsterTalk attention gate (owner-toggled).
   *  Replaced the old server-wide CLAWBITS_ATTENTION_ENABLED env flag. */
  attention_enabled?: boolean;
}

export interface OrgMember {
  human_id: number;
  email: string;
  display_name?: string;
  role: OrgRole;
  joined_at?: string;
  avatar?: AvatarRef | null;
}

export type OAuthProvider = "google" | "github";

/** Server-driven URL to start a Google / GitHub sign-in. The backend
 * redirects to WorkOS → provider → back to ``/api/auth/social/callback``,
 * which sets the session cookie and 302's to ``/home``. */
export function socialAuthUrl(provider: OAuthProvider): string {
  return `/api/auth/social/${provider}/start`;
}

export async function sendMagicCode(email: string): Promise<void> {
  const res = await fetch("/api/auth/magic/send", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function verifyMagicCode(email: string, code: string): Promise<HumanUser> {
  const res = await fetch("/api/auth/magic/verify", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<HumanUser>;
}

/** Complete a social sign-in that WorkOS gated behind email verification.
 * The pending-auth token rides in an httpOnly cookie set by the OAuth
 * callback — we only POST the 6-digit code the user typed in. */
export async function verifySocialEmail(code: string): Promise<HumanUser> {
  const res = await fetch("/api/auth/social/verify-email", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<HumanUser>;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { credentials: "include", method: "POST" });
}

export async function getMe(): Promise<HumanUser> {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<HumanUser>;
}

export async function updateMyProfile(displayName: string | null): Promise<HumanUser> {
  const res = await fetch("/api/human/me", {
    credentials: "include",
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ display_name: displayName }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<HumanUser>;
}

export async function getPrivacySettings(): Promise<PrivacySettings> {
  const res = await fetch("/api/human/privacy-settings", { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<PrivacySettings>;
}

export async function updatePrivacySettings(
  patch: Partial<PrivacySettings>,
): Promise<PrivacySettings> {
  const res = await fetch("/api/human/privacy-settings", {
    credentials: "include",
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<PrivacySettings>;
}

// ---------------------------------------------------------------------------
// Connectors (GitHub, Notion, …) — identity metadata only, never tokens
// ---------------------------------------------------------------------------

export type ConnectorStatus = "connected" | "available" | "coming_soon";

export interface Connector {
  provider: string;
  label: string;
  status: ConnectorStatus;
  capabilities: string[];
  external_id: string | null;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  connected_at: string | null;
}

export interface ConnectorsList { connectors: Connector[] }

export type ConnectResult =
  | { status: "connected"; connector: Connector; url?: null }
  | { status: "redirect"; url: string; connector?: null };

export async function getConnectors(): Promise<ConnectorsList> {
  const res = await fetch("/api/human/connectors", { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ConnectorsList>;
}

export async function connectProvider(provider: string): Promise<ConnectResult> {
  const res = await fetch(`/api/human/connectors/${encodeURIComponent(provider)}/connect`, {
    credentials: "include",
    method: "POST",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ConnectResult>;
}

export async function disconnectProvider(provider: string): Promise<void> {
  const res = await fetch(`/api/human/connectors/${encodeURIComponent(provider)}`, {
    credentials: "include",
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) throw new Error(await res.text());
}

// ---------------------------------------------------------------------------
// Web push notifications
// ---------------------------------------------------------------------------

/** The server's VAPID public key (the browser's ``applicationServerKey``),
 *  or null when web push isn't configured server-side — callers hide the
 *  enable affordance rather than offer a button that can't work. */
export async function getVapidPublicKey(): Promise<string | null> {
  const res = await fetch("/api/push/vapid-public-key", { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { key: string | null };
  return data.key ?? null;
}

/** Register (or refresh) this browser's Web Push subscription. Pass the
 *  object returned by ``PushSubscription.toJSON()`` straight through. */
export async function subscribeWebPush(subscription: PushSubscriptionJSON): Promise<void> {
  const res = await fetch("/api/push/web/subscribe", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription),
  });
  if (!res.ok) throw new Error(await res.text());
}

/** Drop this browser's subscription server-side (user disabled notifications
 *  or the push service rotated the endpoint). */
export async function unsubscribeWebPush(endpoint: string): Promise<void> {
  const res = await fetch("/api/push/web/unsubscribe", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok) throw new Error(await res.text());
}

/** Upload a custom avatar for the current user. Server center-crops
 *  to a square, resizes to 256×256, encodes as WebP, and stores in R2.
 *  Returns the new AvatarRef so callers can swap the URL into local
 *  cache without a refetch. */
export async function uploadOwnAvatar(file: File | Blob): Promise<AvatarRef> {
  const fd = new FormData();
  // The backend FastAPI ``UploadFile`` parameter is named ``file``.
  fd.append("file", file);
  const res = await fetch("/api/human/avatars/users/me/upload", {
    credentials: "include",
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AvatarRef>;
}

/** Revert to the server-generated default avatar (stitched glass).
 *  Bumps avatar_version so the old custom-URL cache key dies and the
 *  new generated SVG is fetched on next render. */
export async function resetOwnAvatar(): Promise<AvatarRef> {
  const res = await fetch("/api/human/avatars/users/me", {
    credentials: "include",
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AvatarRef>;
}

export async function getOrgs(): Promise<{ organizations: Org[]; total: number }> {
  const res = await fetch("/api/human/orgs", { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ organizations: Org[]; total: number }>;
}

export async function getPersonalOrgId(): Promise<string> {
  const data = await getOrgs();
  const personal = data.organizations.find(o => o.is_personal);
  if (!personal) throw new Error("No personal organization found");
  return personal.org_id;
}

export async function createOrg(name: string, displayName?: string): Promise<Org> {
  const res = await fetch("/api/human/orgs", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, display_name: displayName ?? null }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<Org>;
}

export async function getOrg(orgId: string): Promise<Org> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(`/api/human/orgs/${encodeURIComponent(orgId)}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<Org>;
}

/** Bump the caller's ``last_visited_at`` on an org membership. Called
 *  whenever the user switches into an org from the OrgSwitcher so a
 *  freshly-invited org loses its "New" pill the moment it's opened.
 *  Idempotent on the server — safe to call on every switch. */
export async function markOrgVisited(orgId: string): Promise<void> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/visit`,
    { credentials: "include", method: "POST" },
  );
  if (!res.ok) throw new Error(await res.text());
}

export async function listOrgMembers(orgId: string): Promise<{ members: OrgMember[]; total: number }> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(`/api/human/orgs/${encodeURIComponent(orgId)}/members`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ members: OrgMember[]; total: number }>;
}

export async function addOrgMember(
  orgId: string,
  email: string,
  role: OrgRole = "member",
): Promise<{ members: OrgMember[]; total: number }> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(`/api/human/orgs/${encodeURIComponent(orgId)}/members`, {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ members: OrgMember[]; total: number }>;
}

export async function removeOrgMember(
  orgId: string,
  memberId: number,
): Promise<{ members: OrgMember[]; total: number }> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/members/${String(memberId)}`,
    { credentials: "include", method: "DELETE" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ members: OrgMember[]; total: number }>;
}

/** The org's connected self-hosted Reef. clawbits stores ONLY this URL — the
 *  browser talks to Reef directly (see lib/reefApi.ts), never the backend. */
export interface ReefConnection {
  api_url: string | null;
}

export async function getReefConnection(orgId: string): Promise<ReefConnection> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(`/api/human/orgs/${encodeURIComponent(orgId)}/reef-connection`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ReefConnection>;
}

/** Connect (or re-point) the org's Reef. Owner-only on the server. */
export async function setReefConnection(orgId: string, apiUrl: string): Promise<ReefConnection> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(`/api/human/orgs/${encodeURIComponent(orgId)}/reef-connection`, {
    credentials: "include",
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_url: apiUrl }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ReefConnection>;
}

/** Disconnect the org's Reef (clears the stored URL). Owner-only on the server. */
export async function deleteReefConnection(orgId: string): Promise<void> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(`/api/human/orgs/${encodeURIComponent(orgId)}/reef-connection`, {
    credentials: "include",
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await res.text());
}

/** The org's LobsterTalk attention config. ``mode`` picks the pipeline —
 *  ``embedding`` (semantic gate only), ``cascade`` (gate pass → LLM confirm),
 *  ``llm_only`` (no gate: every post goes to the LLM, which fails closed
 *  when unreachable) or ``all`` (no triage at all: every post is delivered
 *  and the agent itself decides whether to reply); the LLM fields only matter
 *  in cascade/llm_only. The API key is write-only: responses carry
 *  ``api_key_set``, never the key itself. */
export interface OrgLobstertalkSettings {
  enabled: boolean;
  mode: "embedding" | "cascade" | "llm_only" | "all";
  base_url: string | null;
  model: string | null;
  api_key_set: boolean;
  /** Per-(agent, channel) nudge cooldown override in seconds; null inherits
   *  ``default_cooldown_seconds`` (the server-resolved default). */
  cooldown_seconds: number | null;
  default_cooldown_seconds: number;
}

/** FastAPI's ``{"detail": "..."}``, falling back to the raw body. */
async function readErrorDetail(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "detail" in parsed) {
      const {detail} = parsed;
      if (typeof detail === "string") return detail;
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return text;
}

export interface SetOrgLobstertalkBody {
  enabled: boolean;
  mode: "embedding" | "cascade" | "llm_only" | "all";
  base_url?: string | null;
  model?: string | null;
  /** Omit to keep the stored key unchanged; set to replace it. */
  api_key?: string;
  /** Deletes the stored key. Mutually exclusive with `api_key`. */
  clear_api_key?: boolean;
  /** Cooldown override in seconds (5–3600); null/omitted inherits the server
   *  default. Whole-state semantics: omitting on a save clears the override. */
  cooldown_seconds?: number | null;
}

export async function getOrgLobstertalk(orgId: string): Promise<OrgLobstertalkSettings> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(`/api/human/orgs/${encodeURIComponent(orgId)}/lobstertalk`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await readErrorDetail(res));
  return res.json() as Promise<OrgLobstertalkSettings>;
}

/** Save the org's LobsterTalk config. Owner-only on the server. */
export async function setOrgLobstertalk(
  orgId: string,
  body: SetOrgLobstertalkBody,
): Promise<OrgLobstertalkSettings> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(`/api/human/orgs/${encodeURIComponent(orgId)}/lobstertalk`, {
    credentials: "include",
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // The endpoint rejects unsafe base URLs (422) and refuses to store a key
  // with no server secrets key (503) with a human-readable ``detail`` — worth
  // unwrapping, since it's the whole diagnosis and it lands in a toast.
  if (!res.ok) throw new Error(await readErrorDetail(res));
  return res.json() as Promise<OrgLobstertalkSettings>;
}

/** One live probe against the org's *stored* LobsterTalk LLM endpoint.
 *  ``ok=false`` means the check ran and the endpoint failed — ``detail``
 *  names the stage (guard, auth, model, JSON shape). Owner-only; spends one
 *  metered call on the org's key. */
export interface OrgLobstertalkHealth {
  ok: boolean;
  detail: string;
  latency_ms: number;
}

export async function checkOrgLobstertalkEndpoint(orgId: string): Promise<OrgLobstertalkHealth> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/lobstertalk/healthcheck`,
    { credentials: "include", method: "POST" },
  );
  if (!res.ok) throw new Error(await readErrorDetail(res));
  return res.json() as Promise<OrgLobstertalkHealth>;
}

/** Approve/revoke one public channel on the org's LobsterTalk allowlist
 *  (closed by default). Owner-only on the server; 422 for non-public. */
export async function setOrgLobstertalkChannel(
  orgId: string,
  channelId: string,
  approved: boolean,
): Promise<{ channel_id: string; lobstertalk_approved: boolean }> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/lobstertalk/channels/${encodeURIComponent(channelId)}`,
    {
      credentials: "include",
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    },
  );
  if (!res.ok) throw new Error(await readErrorDetail(res));
  return res.json() as Promise<{ channel_id: string; lobstertalk_approved: boolean }>;
}

export type AgentSignupStatus = "pending_approval" | "approved" | "rejected";

export interface AgentSignupSession {
  session_token: string;
  challenge: string;
}

export interface AgentSignupRequest {
  request_id: string;
  agent_id: string;
  org_id: string;
  status: AgentSignupStatus;
  created_at?: string;
  reviewed_by?: number;
  reviewed_at?: string;
}

export async function startHumanAgentSignup(orgId: string): Promise<AgentSignupSession> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch("/api/human/agent_signup", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org_id: orgId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AgentSignupSession>;
}

/** Link a reef VM (sandbox id) to the agent a pending signup session will
 *  create. Called by "Add agent → Run on Reef" right after reef returns the
 *  sandbox id, so the resulting agent records which reef VM it runs in. */
export async function linkReefVm(sessionToken: string, sandboxId: string): Promise<void> {
  const res = await fetch("/api/human/agents/link-reef-vm", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_token: sessionToken, sandbox_id: sandboxId }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function listOrgSignupRequests(orgId: string): Promise<{ requests: AgentSignupRequest[] }> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(`/api/human/orgs/${encodeURIComponent(orgId)}/signup-requests`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ requests: AgentSignupRequest[] }>;
}

export async function approveAgentSignupRequest(
  orgId: string,
  requestId: string,
): Promise<AgentSignupRequest> {
  if (!orgId) throw new Error("orgId is required");
  if (!requestId) throw new Error("requestId is required");
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/signup-requests/${encodeURIComponent(requestId)}/approve`,
    { credentials: "include", method: "POST" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AgentSignupRequest>;
}

export async function rejectAgentSignupRequest(
  orgId: string,
  requestId: string,
): Promise<AgentSignupRequest> {
  if (!orgId) throw new Error("orgId is required");
  if (!requestId) throw new Error("requestId is required");
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/signup-requests/${encodeURIComponent(requestId)}/reject`,
    { credentials: "include", method: "POST" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AgentSignupRequest>;
}

/** Hard-delete an agent. When ``keepContent`` is true the agent's authored
 *  content (messages, posts, files, reactions, comments, likes) is
 *  reattributed to a shared "Deleted agent" placeholder instead of being
 *  deleted, so conversation history survives for other channel members. */
export async function removeAgentFromOrg(
  orgId: string,
  agentId: string,
  keepContent = false,
): Promise<{ agent_id: string; org_id: string; deleted: boolean }> {
  if (!orgId) throw new Error("orgId is required");
  if (!agentId) throw new Error("agentId is required");
  const qs = keepContent ? "?keep_content=true" : "";
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}${qs}`,
    { credentials: "include", method: "DELETE" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ agent_id: string; org_id: string; deleted: boolean }>;
}

/** Permanently delete the authenticated user's own account and all their
 *  data. Self-service only. The server clears the session cookies, so the
 *  caller should send the user to a logged-out surface afterwards. Rejects
 *  with the server's message (e.g. 409) when the user still operates agents
 *  or is the sole owner of an org with other members. */
export async function deleteMyAccount(): Promise<void> {
  const res = await fetch("/api/human/account", {
    credentials: "include",
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await extractError(res));
}

export async function getAgents(orgId: string): Promise<{ agents: AgentUser[]; total?: number }> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(`/api/human/orgs/${encodeURIComponent(orgId)}/agents`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ agents: AgentUser[]; total?: number }>;
}

// ---------------------------------------------------------------------------
// Agent AI-usage dashboard — agent-self-reported telemetry (advisory: each
// agent's plugin reports its own token usage; observability, not billing).
// Owners get the per-agent breakdown; members get org totals only — enforced
// server-side. See docs/protocol/AGENT_USAGE_TRACKING_PLAN.md.
// ---------------------------------------------------------------------------

export type UsageRange = "day" | "week" | "month" | "all";

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Null until any costed event exists (OAuth/subscription agents report
   *  tokens but no $). Passthrough from the agent runtime — no pricing table. */
  cost_usd: number | null;
  call_count: number;
}

export interface OrgUsageAgentRow extends UsageTotals {
  agent_id: string;
  nickname?: string | null;
  display_name?: string | null;
  /** False = this agent has never reported usage ("no data" roster state). */
  reporting: boolean;
  /** Up to 3 models by token volume within the selected range. */
  top_models: string[];
}

export interface UsageModelRow extends UsageTotals {
  model: string;
  provider?: string | null;
}

export interface UsageDay extends UsageTotals {
  /** UTC calendar day, ISO (YYYY-MM-DD). */
  date: string;
  /** Owner-only per-agent headline tokens (input+output) for the stacked
   *  trend + sparklines; omitted for members (server-enforced). */
  by_agent?: Record<string, number>;
}

export interface OrgUsageResponse {
  schema_version: string;
  range: UsageRange;
  role: "owner" | "member";
  org_total: UsageTotals;
  /** Day buckets (UTC) inside the window, oldest first. Days with no usage
   *  are absent — the chart zero-fills the window client-side. */
  daily: UsageDay[];
  /** Owner-only; omitted for members (server-enforced). */
  per_agent?: OrgUsageAgentRow[];
  /** Present when requested with group_by=model. */
  per_model?: UsageModelRow[];
}

export interface AgentUsageResponse {
  schema_version: string;
  range: UsageRange;
  agent_id: string;
  reporting: boolean;
  total: UsageTotals;
  per_model: UsageModelRow[];
}

export async function getOrgUsage(
  orgId: string,
  opts: { range: UsageRange; groupBy?: "agent" | "model" },
): Promise<OrgUsageResponse> {
  if (!orgId) throw new Error("orgId is required");
  const params = new URLSearchParams({ range: opts.range });
  if (opts.groupBy) params.set("group_by", opts.groupBy);
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/usage?${params.toString()}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<OrgUsageResponse>;
}

export async function getAgentUsage(
  orgId: string,
  agentId: string,
  opts: { range: UsageRange },
): Promise<AgentUsageResponse> {
  if (!orgId) throw new Error("orgId is required");
  if (!agentId) throw new Error("agentId is required");
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(
      agentId,
    )}/usage?range=${encodeURIComponent(opts.range)}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AgentUsageResponse>;
}

export async function getAgentProfile(orgId: string, agentId: string): Promise<AgentProfile> {
  if (!orgId) throw new Error("orgId is required");
  if (!agentId || agentId === "undefined" || agentId === "null") throw new Error("Invalid Agent ID");
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AgentProfile>;
}

// ---------------------------------------------------------------------------
// Agent contact permissions — who may DM / @-tag an agent. Contact is closed
// by default; the operator or an org owner manages the allowlist.
// ---------------------------------------------------------------------------

export type ContactPrincipalType = "human" | "agent";

export interface ContactPermissionEntry {
  principal_type: ContactPrincipalType;
  principal_id: string;
  display_name?: string | null;
  can_dm: boolean;
  can_tag: boolean;
}

export async function listAgentContactPermissions(
  agentId: string,
): Promise<{ agent_id: string; permissions: ContactPermissionEntry[] }> {
  const res = await fetch(
    `/api/human/agents/${encodeURIComponent(agentId)}/contact-permissions`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ agent_id: string; permissions: ContactPermissionEntry[] }>;
}

export async function setAgentContactPermission(
  agentId: string,
  principalType: ContactPrincipalType,
  principalId: string,
  perms: { can_dm: boolean; can_tag: boolean },
): Promise<ContactPermissionEntry> {
  const res = await fetch(
    `/api/human/agents/${encodeURIComponent(agentId)}/contact-permissions`,
    {
      credentials: "include",
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        principal_type: principalType,
        principal_id: principalId,
        can_dm: perms.can_dm,
        can_tag: perms.can_tag,
      }),
    },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ContactPermissionEntry>;
}

// --- Agent inbox (operator-only) -------------------------------------------
// Mirrors clawbits/datastructures/email_models.py. The human-gated endpoints
// live under the agent base path and are authorized operator-only server-side.

export interface EmailSummary {
  uid: number;
  from_addr: string;
  to_addr: string;
  subject: string;
  date: string;
  is_read: boolean;
  size: number;
  /** Short plain-text preview (~140 chars). Null/absent when unavailable
   *  (e.g. HTML-only mail on servers without IMAP PREVIEW). */
  snippet?: string | null;
  /** Whether the message carries attachments. Null/absent when unknown. */
  has_attachments?: boolean | null;
}

export interface EmailAttachment {
  filename: string;
  content_type: string;
  size: number;
  content_b64?: string | null;
}

export interface EmailDetail extends EmailSummary {
  body_text?: string | null;
  body_html?: string | null;
  attachments: EmailAttachment[];
  headers: Record<string, string>;
}

export interface AgentInbox {
  emails: EmailSummary[];
  total: number;
  unread_count: number;
  limit: number;
  offset: number;
}

export interface AgentInboxCount {
  total: number;
  unread: number;
  email_address: string;
}

function agentEmailBase(orgId: string, agentId: string): string {
  if (!orgId) throw new Error("orgId is required");
  if (!agentId) throw new Error("agentId is required");
  return `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/email`;
}

export async function getAgentInboxCount(
  orgId: string,
  agentId: string,
): Promise<AgentInboxCount> {
  const res = await fetch(`${agentEmailBase(orgId, agentId)}/count`, { credentials: "include" });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<AgentInboxCount>;
}

export async function getAgentInbox(
  orgId: string,
  agentId: string,
  opts: { limit?: number; offset?: number; unreadOnly?: boolean } = {},
): Promise<AgentInbox> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  if (opts.unreadOnly) params.set("unread_only", "true");
  const qs = params.toString();
  const res = await fetch(
    `${agentEmailBase(orgId, agentId)}/inbox${qs ? `?${qs}` : ""}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<AgentInbox>;
}

/** Set or clear a message's read state (the IMAP ``\Seen`` flag) without
 *  opening it — the explicit counterpart to read-on-open. */
export async function setAgentEmailRead(
  orgId: string,
  agentId: string,
  uid: number,
  read: boolean,
): Promise<{ status: string; is_read: boolean }> {
  const res = await fetch(`${agentEmailBase(orgId, agentId)}/${String(uid)}`, {
    credentials: "include",
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_read: read }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<{ status: string; is_read: boolean }>;
}

export async function getAgentEmail(
  orgId: string,
  agentId: string,
  uid: number,
): Promise<EmailDetail> {
  const res = await fetch(`${agentEmailBase(orgId, agentId)}/${String(uid)}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<EmailDetail>;
}

export async function deleteAgentEmail(
  orgId: string,
  agentId: string,
  uid: number,
): Promise<{ status: string }> {
  const res = await fetch(`${agentEmailBase(orgId, agentId)}/${String(uid)}`, {
    credentials: "include",
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<{ status: string }>;
}

// ---------------------------------------------------------------------------
// Mattermost-style channels (human API)
// ---------------------------------------------------------------------------

export type MmChannelType = "public" | "private" | "direct";

export type MmPostStatus = "streaming" | "draft" | "published" | "rejected";

export interface MmChannel {
  channel_id: string;
  org_id?: string | null;
  name: string;
  display_name?: string | null;
  channel_type: MmChannelType;
  /** ``human_users.id`` of the channel creator, when a human created it.
   *  Used client-side to decide whether the current user can moderate
   *  posts (delete others' messages). */
  created_by_human?: number | null;
  created_by_agent?: string | null;
  created_at: string;
  last_message_at?: string | null;
  // Per-viewer state. Server returns these on the channel-list endpoint;
  // single-channel endpoints leave them at zero/false (frontend overlays
  // values from the unread store there).
  unread_count?: number;
  /** Subset of ``unread_count`` whose posts address the current user —
   *  directly (``@<handle>``) or channel-wide (``@here``). Drives the
   *  sidebar/rail accent "mentioned" badge, which shows even when muted.
   *  Server fills it on the channel-list endpoint; single-channel
   *  endpoints leave it at zero. */
  unread_mention_count?: number;
  muted?: boolean;
  /** Per-viewer pin flag. True when the current user has pinned this
   *  channel — the sidebar renders it in a dedicated "Pins" section above
   *  Channels/DMs and excludes it from those sections to avoid duplication. */
  pinned?: boolean;
  // Denormalised one-line preview of the latest published post — drives
  // the Telegram-style sidebar row. Null on channels with no published
  // activity (or pre-migration). Author identity is a snapshot at post
  // time, so a rename won't backfill old previews.
  last_message_text?: string | null;
  last_message_author_human_id?: number | null;
  last_message_author_agent_id?: string | null;
  last_message_author_display_name?: string | null;
  /** Resolved avatar of the last-message author so the sidebar's tiny
   *  preview tile can render the real image, not just an initial. */
  last_message_author_avatar?: AvatarRef | null;
  /** Count of uploaded files on the latest published post. Drives the
   *  paperclip indicator in sidebar / recents previews. Zero (or
   *  undefined on older payloads) means the last message is text-only
   *  or the channel is empty. */
  last_message_attachment_count?: number | null;
  /** On a direct channel with another human, the peer's user id; on a direct
   *  channel with an agent, the peer agent id. Absent for group/public
   *  channels. */
  dm_peer_human_id?: number | null;
  dm_peer_agent_id?: string | null;
  /** Generated channel avatar. Server-side renders a deterministic
   *  marble-style SVG keyed on ``channel_id`` and stores it in R2 — see
   *  ``clawbits.avatars``. Absent on legacy / not-yet-backfilled rows. */
  avatar?: AvatarRef | null;
}

export interface MmPostParentPreview {
  post_id: number;
  agent_id: string | null;
  human_id: number | null;
  poster_display_name: string | null;
  message_excerpt: string;
  status: MmPostStatus;
}

export interface MmPostReaction {
  /** The unicode glyph (e.g. "👍"). */
  emoji: string;
  /** Total members who reacted with this emoji. */
  count: number;
  /** Human user IDs who reacted. Derive "did I react?" by checking
   *  whether the current user's id appears here. */
  human_ids: number[];
  /** Agent IDs who reacted. */
  agent_ids: string[];
}

export type MmFileStatus = "pending" | "uploaded" | "failed" | "deleted";

/** Chat attachment metadata. ``download_url`` / ``thumbnail_url`` are
 *  short-lived presigned R2 URLs — only populated for image files in the
 *  post-read response, since ``<img src>`` needs them eagerly. For other
 *  types the client fetches the URL on demand via ``getMmFileDownloadUrl``. */
export interface MmFile {
  file_id: string;
  channel_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  status: MmFileStatus;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  created_at: string;
  uploaded_at?: string | null;
  download_url?: string | null;
  /** Unix epoch seconds when ``download_url`` stops being valid on R2.
   *  Used by the attachment URL cache so we don't keep handing an
   *  ``<img>`` element a URL that has already expired server-side. */
  download_url_expires_at?: number | null;
  thumbnail_url?: string | null;
  thumbnail_url_expires_at?: number | null;
  /** Uploader identity + source message. Populated by the channel
   *  attachments listing endpoint (and the per-file enrichment) so the
   *  attachments history can show "shared by …" and link back to the
   *  originating message. Absent on the per-post ``files[]`` payload. */
  uploader_human_id?: number | null;
  uploader_agent_id?: string | null;
  post_id?: number | null;
}

/** Broad content-type bucket for the channel attachments history (the
 *  Media / Files tabs). The endpoint also accepts an explicit
 *  ``content_type`` query param (exact, or a prefix when it ends with
 *  ``/``) for narrower filters.
 *
 *  - ``image`` / ``video`` — leading ``content_type`` prefix match
 *  - ``media`` — union of the two in one chronological stream (drives the
 *    unified Media tab so a video posted between two images stays in place)
 *  - ``file`` — everything else (audio, application/*, text/*, …)
 *  - ``all`` — no content-type filter; every uploaded attachment
 */
export type MmAttachmentKind = "image" | "video" | "media" | "file" | "all";

export interface MmFileListResponse {
  files: MmFile[];
  limit: number;
  has_more: boolean;
  /** ``file_id`` to pass back as ``beforeFileId`` for the next page;
   *  ``null`` when ``has_more`` is false. */
  next_cursor: string | null;
  /** Echoed back only when the request used offset pagination. */
  offset: number | null;
  /** Total matching rows; present only when ``includeTotal`` was set. */
  total: number | null;
}

export interface ListChannelAttachmentsParams {
  /** Broad bucket. Server default is ``media``; pass ``all`` for no
   *  content-type filter at all. */
  kind?: MmAttachmentKind;
  /** Exact MIME (e.g. ``"application/pdf"``) or a prefix when it ends
   *  with ``/`` (e.g. ``"audio/"``). Overrides ``kind`` when set. */
  contentType?: string;
  /** 1..200. Default 50. */
  limit?: number;
  /** Cursor: ``file_id`` from the previous response's ``next_cursor``.
   *  Preferred over ``offset`` — correct under concurrent inserts and
   *  O(limit) at any depth. */
  beforeFileId?: string;
  /** Jump-to-page offset; slower past a few thousand rows. */
  offset?: number;
  /** Opt-in for the ``total`` field. Off by default — the COUNT(*) is
   *  O(matching_rows). */
  includeTotal?: boolean;
}

export interface MmLinkItem {
  url: string;
  post_id: number;
  post_created_at: string;
}

export interface MmLinkListResponse {
  links: MmLinkItem[];
  limit: number;
  has_more: boolean;
  /** ``post_id`` to pass back as ``beforePostId`` for the next page. */
  next_cursor: number | null;
  offset: number | null;
}

export interface ListChannelLinksParams {
  limit?: number;
  /** Cursor: ``post_id`` from the previous response's ``next_cursor``. */
  beforePostId?: number;
  offset?: number;
}

export interface MmChannelPost {
  post_id: number;
  channel_id: string;
  agent_id: string | null;
  human_id: number | null;
  poster_display_name: string | null;
  /** Avatar of the post author (human or agent). Absent on legacy /
   *  not-yet-backfilled rows; the renderer falls back to an initial
   *  letter when missing. */
  avatar?: AvatarRef | null;
  message: string;
  created_at: string;
  status: MmPostStatus;
  updated_at?: string | null;
  /** ISO timestamp of the most recent user-visible edit, or null if the
   *  post has never been edited. Drives the "(edited)" marker. */
  edited_at?: string | null;
  /** ISO timestamp of the moment this post was pinned, or null if the
   *  post is not currently pinned. Drives the small pin glyph next to
   *  the message timestamp and inclusion in the pinned-messages popover. */
  pinned_at?: string | null;
  /** The human who pinned the post, or null if not pinned. */
  pinned_by_human_id?: number | null;
  /** Inline-reply parent. Null for top-level posts. */
  parent_post_id?: number | null;
  /** Snapshot of the parent at read time — author + excerpt + status.
   *  Status mirrors the parent's *current* state so the UI can render
   *  "Original message removed" when it was rejected. */
  parent_preview?: MmPostParentPreview | null;
  /** Server-resolved OG card for the first shareable URL in the message.
   *  ``null`` (or missing) on legacy posts predating server-side unfurl —
   *  in that case the renderer falls back to the client-side
   *  ``useLinkPreview`` hook for the first URL it extracts. When present
   *  the renderer skips the async fetch entirely, eliminating the
   *  skeleton-to-card layout shift. */
  link_preview?: MmPostLinkPreviewEmbedded | null;
  /** Emoji reactions aggregated per-emoji. Empty when no one has reacted. */
  reactions?: MmPostReaction[];
  /** Attached files (images, docs, …). Empty when the post has no
   *  attachments. Image files arrive with an inline ``download_url`` so
   *  the renderer can use ``<img src>`` without an extra round trip. */
  files?: MmFile[];
  /** Echoed back from ``MmPostRequest.client_msg_uuid`` only on the
   *  synchronous create response and the post.created SSE event — never
   *  set on plain reads. The sender uses it to reconcile their
   *  locally-inserted optimistic post against the server's canonical
   *  one, regardless of which arrives first (HTTP response vs SSE). */
  client_msg_uuid?: string | null;
}

export interface MmDiscoverableChannel {
  channel_id: string;
  org_id?: string | null;
  name: string;
  display_name?: string | null;
  channel_type: MmChannelType;
  created_at: string;
  member_count: number;
  avatar?: AvatarRef | null;
}

export async function listDiscoverableMmChannels(
  orgId: string,
): Promise<{ channels: MmDiscoverableChannel[]; total: number }> {
  const res = await fetch(
    `/api/human/mm/channels/discoverable?org_id=${encodeURIComponent(orgId)}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ channels: MmDiscoverableChannel[]; total: number }>;
}

export async function joinMmChannel(channelId: string): Promise<MmChannel> {
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/join`,
    { credentials: "include", method: "POST" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmChannel>;
}

/** Row in the org-admin channels-management list. Mirrors the backend
 *  ``MmAdminChannelResponse`` — a subset of ``MmChannel`` plus ``member_count``.
 *  DMs are excluded server-side. */
export interface MmAdminChannel {
  channel_id: string;
  org_id: string | null;
  name: string;
  display_name?: string | null;
  channel_type: Exclude<MmChannelType, "direct">;
  created_at: string;
  created_by_human?: number | null;
  last_message_at?: string | null;
  last_message_text?: string | null;
  member_count: number;
  avatar?: AvatarRef | null;
  /** Per-channel LobsterTalk allowlist state (closed by default). Only ever
   *  true for public channels; drives the Settings → LobsterTalk toggles. */
  lobstertalk_approved: boolean;
}

export async function listAllOrgChannels(
  orgId: string,
): Promise<{ channels: MmAdminChannel[]; total: number }> {
  const res = await fetch(
    `/api/human/mm/orgs/${encodeURIComponent(orgId)}/channels`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ channels: MmAdminChannel[]; total: number }>;
}

export async function deleteMmChannel(channelId: string): Promise<void> {
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}`,
    { credentials: "include", method: "DELETE" },
  );
  if (!res.ok) throw new Error(await res.text());
}

export async function listMmChannels(
  orgId?: string | null,
): Promise<{ channels: MmChannel[]; total: number }> {
  const url = orgId
    ? `/api/human/mm/channels?org_id=${encodeURIComponent(orgId)}`
    : "/api/human/mm/channels";
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ channels: MmChannel[]; total: number }>;
}

export async function getMmChannel(channelId: string): Promise<MmChannel> {
  const res = await fetch(`/api/human/mm/channels/${encodeURIComponent(channelId)}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmChannel>;
}

export async function createMmChannel(
  orgId: string,
  name: string,
  displayName?: string,
  channelType: "public" | "private" = "public",
): Promise<MmChannel> {
  if (!orgId) throw new Error("Organization is required");
  const res = await fetch("/api/human/mm/channels", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      org_id: orgId,
      name,
      display_name: displayName ?? null,
      channel_type: channelType,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmChannel>;
}

export async function createOrGetMmDirect(
  orgId: string,
  targetType: "agent" | "human",
  targetId: string,
): Promise<MmChannel> {
  const res = await fetch("/api/human/mm/direct", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org_id: orgId, target_type: targetType, target_id: targetId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmChannel>;
}

// ---------------------------------------------------------------------------
// Message content search (Tier 2) — see docs/protocol/SEARCH_SPEC.md
// ---------------------------------------------------------------------------

export type MmSearchSort = "recent" | "relevant";

export interface MmSearchAuthor {
  kind: "human" | "agent";
  human_id?: number | null;
  agent_id?: string | null;
  display_name?: string | null;
  avatar?: AvatarRef | null;
}

export interface MmSearchResult {
  post_id: number;
  channel_id: string;
  channel_display_name?: string | null;
  channel_type: MmChannelType;
  created_at: string;
  author: MmSearchAuthor;
  /** Highlighted excerpt: matched terms wrapped in ``<mark>…</mark>``; the
   *  rest is HTML-escaped server-side. Render via a sanitised highlighter. */
  snippet: string;
  rank: number;
}

export interface MmSearchResponse {
  results: MmSearchResult[];
  /** Opaque pagination token; pass back as ``cursor``. Null = last page. */
  next_cursor: string | null;
  query: string;
  sort: string;
}

export interface SearchMessagesParams {
  orgId: string | null;
  query: string;
  /** Restrict to one channel/DM (in-channel search; the ``in:`` operator). */
  channelId?: string | null;
  sort?: MmSearchSort;
  cursor?: string | null;
  limit?: number;
  /** Operator filters, resolved to ids client-side. */
  fromHumanId?: number | null;
  fromAgentId?: string | null;
  /** ``YYYY-MM-DD`` (or ISO) bounds on created_at. */
  before?: string | null;
  after?: string | null;
  hasLink?: boolean;
  hasFile?: boolean;
}

/**
 * Tier-2 message content search. This is the federation seam from
 * SEARCH_SPEC.md: today it calls the server FTS endpoint (plaintext
 * channels only); when E2EE channels ship, an on-device index for encrypted
 * channels will be merged in here so callers stay unchanged.
 */
export async function searchMessages(
  params: SearchMessagesParams,
): Promise<MmSearchResponse> {
  const qs = new URLSearchParams();
  qs.set("q", params.query);
  if (params.orgId) qs.set("org_id", params.orgId);
  if (params.channelId) qs.set("channel_id", params.channelId);
  if (params.sort) qs.set("sort", params.sort);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.fromHumanId != null) qs.set("from_human_id", String(params.fromHumanId));
  if (params.fromAgentId) qs.set("from_agent_id", params.fromAgentId);
  if (params.before) qs.set("before", params.before);
  if (params.after) qs.set("after", params.after);
  if (params.hasLink) qs.set("has_link", "true");
  if (params.hasFile) qs.set("has_file", "true");
  const res = await fetch(`/api/human/mm/search?${qs.toString()}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmSearchResponse>;
}

// Module-level ETag cache for the post-list endpoint. The browser can't
// auto-validate because the global cache-control middleware emits
// ``no-store`` on every response — so we drive ``If-None-Match``/304
// ourselves and reuse the cached JSON when the server says "no change".
// Key = the request URL (channel + paging); we never see the same URL
// twice for different users in this single-user-per-tab app.
interface MmPostListPayload {
  posts: MmChannelPost[];
  total: number;
  limit: number;
  offset: number;
}
const postListEtagCache = new Map<string, { etag: string; data: MmPostListPayload }>();

export async function listMmChannelPosts(
  channelId: string,
  limit = 50,
  offset = 0,
  beforePostId?: number,
  afterPostId?: number,
): Promise<MmPostListPayload> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (beforePostId != null) params.set("before_post_id", String(beforePostId));
  // Scroll-down cursor for an anchored history window (jump-to-pinned): the
  // posts immediately newer than this id, never the live tail.
  if (afterPostId != null) params.set("after_post_id", String(afterPostId));
  const url = `/api/human/mm/channels/${encodeURIComponent(channelId)}/posts?${params.toString()}`;

  const cached = postListEtagCache.get(url);
  const headers: Record<string, string> = {};
  if (cached) headers["If-None-Match"] = cached.etag;

  const res = await fetch(url, { credentials: "include", headers });

  if (res.status === 304 && cached) {
    // Server confirmed nothing changed — reuse the cached payload.
    return cached.data;
  }
  if (!res.ok) throw new Error(await res.text());

  const data = (await res.json()) as MmPostListPayload;
  const etag = res.headers.get("ETag");
  if (etag) postListEtagCache.set(url, { etag, data });
  return data;
}

/** Window of posts centred on ``postId`` (newest-first) — up to ``radius``
 *  older and ``radius`` newer. Powers "jump to message" (a pinned message, a
 *  search hit, a reply quote) when the target sits outside the loaded window:
 *  the caller re-anchors the timeline on this island and paginates both ways
 *  from it, instead of page-walking back from the live tail. Not ETag-cached —
 *  it's a one-shot read on an explicit user action, not a poll. */
export async function listMmPostsAround(
  channelId: string,
  postId: number,
  radius = 25,
): Promise<MmPostListPayload> {
  const url = `/api/human/mm/channels/${encodeURIComponent(channelId)}/posts/around/${encodeURIComponent(String(postId))}?radius=${String(radius)}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmPostListPayload>;
}

/** Inline channel timeline event. Currently the union covers
 *  membership changes only; ``event_type`` is left as a free string so
 *  future event types (channel.renamed, topic.changed, etc.) can flow
 *  through the same component without a wire-type bump. */
export interface MmChannelEvent {
  event_id: number;
  channel_id: string;
  event_type: string;
  actor_human_id: number | null;
  actor_agent_id: string | null;
  actor_display_name: string | null;
  actor_avatar: AvatarRef | null;
  /** NULL when the actor acted on themselves — the renderer uses this
   *  to pick "joined"/"left" over "added X"/"removed X". */
  subject_human_id: number | null;
  subject_agent_id: string | null;
  subject_display_name: string | null;
  subject_avatar: AvatarRef | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface MmChannelEventListPayload {
  events: MmChannelEvent[];
  total: number;
}

export async function listMmChannelEvents(
  channelId: string,
  limit = 100,
): Promise<MmChannelEventListPayload> {
  const params = new URLSearchParams({ limit: String(limit) });
  // ``/inline-events``, not ``/events`` — the latter is the per-channel
  // SSE stream (text/event-stream). See backend comment near
  // ``list_channel_events``.
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/inline-events?${params.toString()}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmChannelEventListPayload>;
}

export interface MmMarkReadResponse {
  channel_id: string;
  last_read_post_id: number;
}

export async function markMmChannelRead(
  channelId: string,
  postId: number,
): Promise<MmMarkReadResponse> {
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/read`,
    {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: postId }),
    },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmMarkReadResponse>;
}

export interface MmMuteResponse {
  channel_id: string;
  muted: boolean;
}

export interface MmPinResponse {
  channel_id: string;
  pinned: boolean;
}

// ---------------------------------------------------------------------------
// Dev auth (local dev only — backend returns 404 when disabled)
// ---------------------------------------------------------------------------

export async function getDevAuthEnabled(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/dev/enabled", { credentials: "include" });
    if (!res.ok) return false;
    const json = (await res.json()) as { enabled: boolean };
    return json.enabled;
  } catch {
    return false;
  }
}

export async function devLogin(
  email: string,
  displayName?: string,
): Promise<HumanUser> {
  const res = await fetch("/api/auth/dev/login", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      display_name: displayName ?? null,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<HumanUser>;
}

export async function setMmChannelMuted(
  channelId: string,
  muted: boolean,
): Promise<MmMuteResponse> {
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/mute`,
    {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ muted }),
    },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmMuteResponse>;
}

export async function setMmChannelPinned(
  channelId: string,
  pinned: boolean,
): Promise<MmPinResponse> {
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/pin`,
    {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned }),
    },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmPinResponse>;
}

export interface AgentSettingsResponse {
  agent_id: string;
  inter_agent_mode_enabled: boolean;
  snoozed: boolean;
  inter_agent_message_limit: number;
  lobstertalk_enabled: boolean;
  lobstertalk_ollama_host: string | null;
  lobstertalk_ollama_model: string | null;
  lobstertalk_interval_seconds: number;
  lobstertalk_message_limit: number;
}

export async function updateAgentSettings(
  orgId: string,
  agentId: string,
  settings: {
    inter_agent_mode_enabled?: boolean;
    snoozed?: boolean;
    inter_agent_message_limit?: number;
    lobstertalk_enabled?: boolean;
    /** Empty string clears the setting (falls back to the sidecar default). */
    lobstertalk_ollama_host?: string;
    /** Empty string clears the model; the sidecar then idles until one is set. */
    lobstertalk_ollama_model?: string;
    lobstertalk_interval_seconds?: number;
    lobstertalk_message_limit?: number;
  },
): Promise<AgentSettingsResponse> {
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/settings`,
    {
      credentials: "include",
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AgentSettingsResponse>;
}

/** Rename an agent (operator-only). Replaces the generated nickname; the
 *  server also clears any agent-set profile display_name so the new name is
 *  what every surface resolves to. ``agent_id`` never changes. */
export async function renameAgent(
  orgId: string,
  agentId: string,
  nickname: string,
): Promise<{ agent_id: string; nickname: string }> {
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/name`,
    {
      credentials: "include",
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname }),
    },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ agent_id: string; nickname: string }>;
}

/** Ask an agent to regenerate its description. Operator-only on the server;
 *  sets a flag the agent picks up on its next check-in (generation is
 *  agent-side), so the result arrives asynchronously. */
export async function regenerateAgentDescription(
  orgId: string,
  agentId: string,
): Promise<{ agent_id: string; description_regen_pending: boolean }> {
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/description/regenerate`,
    { credentials: "include", method: "POST" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ agent_id: string; description_regen_pending: boolean }>;
}

/** Manually set an agent's public description (operator or org owner).
 *  Stored with ``source="manual"``; clears any pending regenerate request. */
export async function setAgentDescription(
  orgId: string,
  agentId: string,
  description: string,
): Promise<{ agent_id: string; description: string; description_source: string }> {
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/description`,
    {
      credentials: "include",
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{
    agent_id: string;
    description: string;
    description_source: string;
  }>;
}

export async function sendMmTypingHeartbeat(channelId: string): Promise<void> {
  await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/typing`,
    { credentials: "include", method: "POST" },
  );
}

export type GlobalUserStatus = "online" | "idle" | "offline";

/** Global liveness for an agent (the analogue of a human's online dot),
 *  derived from its last alive-ping. See ``@/lib/agentLiveness``. */
export type AgentLivenessStatus = "setup" | "available" | "offline";

export async function sendGlobalPresenceHeartbeat(
  status: GlobalUserStatus,
  options?: { keepalive?: boolean },
): Promise<void> {
  await fetch("/api/human/presence", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
    keepalive: options?.keepalive,
  });
}

// ---------------------------------------------------------------------------
// Channel members (mixed human + agent)
// ---------------------------------------------------------------------------

export type MmMemberType = "agent" | "human";

export interface MmChannelMember {
  agent_id: string | null;
  human_id: number | null;
  display_name: string | null;
  joined_at: string;
  /** Seeded by the server from Redis on first paint; live updates come
   *  in via the channel SSE ``user.status`` event. Null for agents. */
  status: GlobalUserStatus | null;
  last_seen_at: string | null;
  /** Bucketed "Last seen recently" string set in place of
   *  ``last_seen_at`` when the member has hidden their precise
   *  last-seen via privacy settings. Null when the timestamp is
   *  exposed. */
  last_seen_label?: string | null;
  /** Member avatar (user or agent). Absent on legacy rows. */
  avatar?: AvatarRef | null;
  /** Highest post_id this human has marked read. Null when they've
   *  never opened the channel. Maintained via SSE ``member.read``.
   *  Drives DM read-receipt indicators under outgoing messages. */
  last_read_post_id?: number | null;
  /** Global agent liveness — set for AGENT members only (null for humans).
   *  The server's snapshot at read time; the client re-derives available->
   *  offline locally from ``last_alive_at`` so the dot flips at the 40-min
   *  mark. Live updates arrive via the ``agent.status`` SSE event. */
  agent_status?: AgentLivenessStatus | null;
  /** Raw last alive-ping timestamp (ISO) for agent members; null for humans
   *  and for agents that have never pinged (which read as "setup"). */
  last_alive_at?: string | null;
  /** Per-viewer contact gate for AGENT members: whether the current human may
   *  ``@``-tag this agent (contact is closed by default). Null for humans /
   *  payloads that don't compute it — treated as "allowed" for back-compat. */
  can_tag?: boolean | null;
}

export interface MmChannelMembersResponse {
  members: MmChannelMember[];
  total: number;
  /** True when the member removal left the channel with no humans and the
   *  server hard-deleted it. ``members``/``total`` are empty in that case. */
  channel_deleted?: boolean;
}

export async function listMmChannelMembers(channelId: string): Promise<MmChannelMembersResponse> {
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/members`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmChannelMembersResponse>;
}

export async function addMmChannelMember(
  channelId: string,
  memberId: string,
  memberType: MmMemberType,
): Promise<MmChannelMembersResponse> {
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/members`,
    {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: memberId, member_type: memberType }),
    },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmChannelMembersResponse>;
}

export async function removeMmChannelMember(
  channelId: string,
  memberId: string,
  memberType: MmMemberType,
): Promise<MmChannelMembersResponse> {
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(memberId)}?member_type=${memberType}`,
    { credentials: "include", method: "DELETE" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmChannelMembersResponse>;
}

/** Semantic shortcut for the current user leaving a channel. */
export async function leaveMmChannel(
  channelId: string,
  humanId: number,
): Promise<MmChannelMembersResponse> {
  return removeMmChannelMember(channelId, String(humanId), "human");
}

/** Rewrite the text of a previously-published post the caller authored.
 *  Stamps ``edited_at`` server-side so the UI can render the permanent
 *  "(edited)" marker. Other channel members see the change via SSE. */
export async function editMmChannelPost(
  postId: number,
  message: string,
): Promise<MmChannelPost> {
  const res = await fetch(`/api/human/mm/posts/${encodeURIComponent(String(postId))}`, {
    credentials: "include",
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmChannelPost>;
}

/** Hard-delete a channel post. Allowed for the post's author or the
 *  channel creator. Replies that quoted this post become top-level (their
 *  parent is set to NULL); reactions cascade. Returns 204 on success;
 *  404 if the post doesn't exist; 403 if the caller is neither author nor
 *  channel creator. */
export async function deleteMmChannelPost(postId: number): Promise<void> {
  const res = await fetch(`/api/human/mm/posts/${encodeURIComponent(String(postId))}`, {
    credentials: "include",
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw new Error(await extractError(res));
}

/** Toggle a reaction on a channel post. Slack/Discord semantics: if the
 *  caller already reacted with this emoji, the row is removed; otherwise
 *  it's added. Returns the fully-rehydrated post (with updated reactions). */
export async function toggleMmPostReaction(
  postId: number,
  emoji: string,
): Promise<MmChannelPost> {
  const res = await fetch(`/api/human/mm/posts/${encodeURIComponent(String(postId))}/reactions`, {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emoji }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<MmChannelPost>;
}

/** Pin a channel post. Any channel member can pin; idempotent on the
 *  server (re-pinning preserves the original timestamp). Returns the
 *  rehydrated post with ``pinned_at`` populated. */
export async function pinMmPost(postId: number): Promise<MmChannelPost> {
  const res = await fetch(`/api/human/mm/posts/${encodeURIComponent(String(postId))}/pin`, {
    credentials: "include",
    method: "POST",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<MmChannelPost>;
}

/** Unpin a channel post. Any channel member can unpin; idempotent. */
export async function unpinMmPost(postId: number): Promise<MmChannelPost> {
  const res = await fetch(`/api/human/mm/posts/${encodeURIComponent(String(postId))}/pin`, {
    credentials: "include",
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<MmChannelPost>;
}

/** List every pinned post in a channel, newest-pinned first. Returns the
 *  full set (no pagination) so the popover can display pins that are
 *  outside the loaded scroll window. */
export async function listPinnedMmPosts(
  channelId: string,
): Promise<{ posts: MmChannelPost[]; total: number }> {
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/pins`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<{ posts: MmChannelPost[]; total: number }>;
}

export async function createMmChannelPost(
  channelId: string,
  message: string,
  parentPostId?: number | null,
  fileIds?: string[],
  clientMsgUuid?: string,
): Promise<MmChannelPost> {
  const body: {
    message: string;
    parent_post_id?: number;
    file_ids?: string[];
    client_msg_uuid?: string;
    trace_id?: string;
  } = { message };
  if (parentPostId != null) body.parent_post_id = parentPostId;
  if (fileIds && fileIds.length > 0) body.file_ids = fileIds;
  // Optimistic-send dedupe key. The server echoes it on the create
  // response and the post.created SSE event so the sender can match
  // the canonical post against its locally-inserted optimistic one
  // without relying on content fingerprinting.
  if (clientMsgUuid) body.client_msg_uuid = clientMsgUuid;
  // End-to-end latency trace id. Minted here at the user's send and threaded
  // (server-persisted) through every hop of the round-trip — server → agent
  // pickup → OpenClaw turn → reply → SSE — so the cross-subsystem tracer can
  // stitch one waterfall and show where a slow reply spends its time. Rides
  // both the body (persisted on the post) and the ``x-clawbits-trace-id``
  // header (so the server logs its sync-leg span under the same id).
  const traceId = `tr_${crypto.randomUUID()}`;
  body.trace_id = traceId;
  const traceStartedAt = Date.now();
  const res = await fetch(`/api/human/mm/channels/${encodeURIComponent(channelId)}/posts`, {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json", "x-clawbits-trace-id": traceId },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  const post = (await res.json()) as MmChannelPost;
  // Trace breadcrumb for the synchronous send leg. Logged to the devtools
  // console AND shipped to the standalone trace viewer's ring sink, so this
  // otherwise-ephemeral frontend span lines up with the server ``TRACE`` log
  // and the plugin spans in one waterfall at ``/trace``.
  try {
    const tEnd = Date.now();
    const span = {
      trace_id: traceId,
      span: "frontend.send_post",
      subsystem: "frontend",
      dur_ms: tEnd - traceStartedAt,
      t_start_ms: traceStartedAt,
      t_end_ms: tEnd,
      channel_id: channelId,
      post_id: post.post_id,
      client_msg_uuid: clientMsgUuid ?? null,
    };
    console.debug(`[clawbits-trace] ${JSON.stringify(span)}`);
    // Fire-and-forget; a trace breadcrumb must never break or delay a send.
    void fetch("/api/trace/spans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(span),
    }).catch(() => undefined);
  } catch {
    /* a trace breadcrumb must never break a send */
  }
  return post;
}

// ---------------------------------------------------------------------------
// Link previews (OpenGraph unfurl)
// ---------------------------------------------------------------------------

/** OpenGraph metadata for a URL, served by the backend unfurler. The
 *  server caches Redis-side for 24h on success / 5min on failure, so
 *  the same URL across many clients only hits the upstream once.
 *  Failures come back with ``error`` set and the data fields null —
 *  clients should hide the card rather than render a broken one. */
export interface LinkPreviewData {
  url: string;
  canonical_url: string | null;
  title: string | null;
  description: string | null;
  image_url: string | null;
  site_name: string | null;
  fetched_at: number;
  error: string | null;
}

/** Server-resolved OG card embedded on an ``MmChannelPost`` at create /
 *  edit time. Shape mirrors :class:`LinkPreviewData` plus a ``skipped``
 *  counter so the UI can surface "1 of N previews" affordances later if
 *  needed. Optional fields default to ``null``-via-undefined; the
 *  ``LinkPreviewCard`` accepts both. */
export interface MmPostLinkPreviewEmbedded {
  url: string;
  canonical_url?: string | null;
  title?: string | null;
  description?: string | null;
  image_url?: string | null;
  site_name?: string | null;
  fetched_at?: number | null;
  error?: string | null;
  skipped?: number;
}

/** Fetch an OG card for ``url`` via the server-side unfurler. Always
 *  resolves — upstream failures land as a payload with ``error`` set,
 *  not a thrown exception. */
export async function fetchLinkPreview(url: string): Promise<LinkPreviewData> {
  const res = await fetch("/api/human/mm/link-preview", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<LinkPreviewData>;
}

// ---------------------------------------------------------------------------
// Chat attachments — upload protocol
// ---------------------------------------------------------------------------

export interface MmFileUploadRequest {
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256?: string;
  has_thumbnail?: boolean;
  /** Required when ``has_thumbnail=true``. The thumbnail PUT signature
   *  pins Content-Length to this value, so the browser's XHR (which
   *  always sends actual blob size) is rejected by R2 on a mismatch. */
  thumbnail_size_bytes?: number;
}

export interface MmFileUploadResponse {
  file_id: string;
  upload_url: string;
  upload_headers: Record<string, string>;
  upload_expires_in: number;
  object_key: string;
  thumbnail_upload_url?: string | null;
  thumbnail_upload_headers?: Record<string, string> | null;
  thumbnail_object_key?: string | null;
}

export interface MmFileConfirmRequest {
  width?: number;
  height?: number;
  duration_ms?: number;
  sha256?: string;
  thumbnail_uploaded?: boolean;
}

/** Try to extract a clean error message from a non-OK response. The
 *  backend's HTTPException handler emits ``{error, status_code, detail,
 *  path}``; we prefer ``detail`` over the raw JSON envelope when surfacing
 *  errors in toasts and chip status. */
async function extractError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { detail?: string };
    if (typeof j.detail === "string" && j.detail) return j.detail;
  } catch {
    /* not JSON */
  }
  return text || res.statusText || String(res.status);
}

export async function requestMmFileUpload(
  channelId: string,
  body: MmFileUploadRequest,
): Promise<MmFileUploadResponse> {
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/files`,
    {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<MmFileUploadResponse>;
}

export async function confirmMmFileUpload(
  fileId: string,
  body: MmFileConfirmRequest,
): Promise<MmFile> {
  const res = await fetch(
    `/api/human/mm/files/${encodeURIComponent(fileId)}/confirm`,
    {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<MmFile>;
}

export async function getMmFileDownloadUrl(
  fileId: string,
): Promise<{ url: string; expires_in: number; expires_at: number }> {
  const res = await fetch(
    `/api/human/mm/files/${encodeURIComponent(fileId)}/url`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<{
    url: string;
    expires_in: number;
    expires_at: number;
  }>;
}

export async function deleteMmFile(fileId: string): Promise<void> {
  const res = await fetch(`/api/human/mm/files/${encodeURIComponent(fileId)}`, {
    credentials: "include",
    method: "DELETE",
  });
  // 404 from the backend means "doesn't exist or not yours" — same shape
  // for either case (intentional, to avoid leaking ownership). Caller can
  // ignore it during cancel flows.
  if (!res.ok && res.status !== 404) throw new Error(await extractError(res));
}

// ---------------------------------------------------------------------------
// Chat attachments — channel-wide history listing (Media / Files / Links)
// ---------------------------------------------------------------------------

/** Paginated channel attachments, sliced by content-type ``kind``. Backs the
 *  Attachments sidebar's Media / Files tabs. Cursor pagination via
 *  ``beforeFileId`` (the previous page's ``next_cursor``). Cookie-authed and
 *  gated server-side by channel membership. */
export async function listChannelAttachments(
  channelId: string,
  params: ListChannelAttachmentsParams = {},
): Promise<MmFileListResponse> {
  const query = new URLSearchParams();
  if (params.kind) query.set("kind", params.kind);
  if (params.contentType) query.set("content_type", params.contentType);
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.beforeFileId) query.set("before_file_id", params.beforeFileId);
  if (params.offset) query.set("offset", String(params.offset));
  if (params.includeTotal) query.set("include_total", "true");
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/attachments${suffix}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<MmFileListResponse>;
}

/** Distinct URLs harvested from a channel's message bodies, newest first.
 *  Backs the Attachments sidebar's Links tab. Each row is unfurled
 *  client-side via ``fetchLinkPreview``. */
export async function listChannelLinks(
  channelId: string,
  params: ListChannelLinksParams = {},
): Promise<MmLinkListResponse> {
  const query = new URLSearchParams();
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.beforePostId != null)
    query.set("before_post_id", String(params.beforePostId));
  if (params.offset) query.set("offset", String(params.offset));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const res = await fetch(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/links${suffix}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<MmLinkListResponse>;
}

/** Progress callback for ``putToR2``. ``loaded`` and ``total`` are bytes;
 *  ``total`` may be 0 if the server didn't send a Content-Length response
 *  header (it doesn't for R2). Treat it as best-effort. */
export type UploadProgress = (loaded: number, total: number) => void;

/** Direct PUT to a presigned R2 URL. Uses XHR (not ``fetch``) because we
 *  need real-time upload progress events. The signal supports cancellation
 *  via ``AbortController``. */
export function putToR2(
  url: string,
  headers: Record<string, string>,
  body: Blob,
  onProgress?: UploadProgress,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        onProgress(e.loaded, e.lengthComputable ? e.total : 0);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`R2 upload failed: ${String(xhr.status)} ${xhr.statusText}`));
    };
    xhr.onerror = () => { reject(new Error("R2 upload network error")); };
    xhr.onabort = () => { reject(new DOMException("Upload aborted", "AbortError")); };
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener("abort", () => { xhr.abort(); }, { once: true });
    }
    xhr.send(body);
  });
}

// ---------------------------------------------------------------------------
// Automations — Clawbits' control plane over OpenClaw cron. Operators set the
// DESIRED automations; the agent's plugin reconciles and reports back. Reads
// and writes are operator-gated. See
// docs/protocol/OPENCLAW_AUTOMATIONS_INTEGRATION_STRATEGY.md.
// ---------------------------------------------------------------------------

export type AutomationSyncStatus = "requested" | "applied" | "failed" | "removing";
export type AutomationManagedBy = "clawbits" | "external";

/** Runtime state the agent reported (a projection of OpenClaw's CronJobState). */
export interface AutomationReportedState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: string;
  lastError?: string;
  consecutiveErrors?: number;
  lastDurationMs?: number;
  runningAtMs?: number;
  [key: string]: unknown;
}

export interface Automation {
  automation_id: string;
  agent_id: string;
  org_id: string | null;
  managed_by: AutomationManagedBy;
  /** Surfaced from the desired spec, falling back to the reported mirror. */
  name: string | null;
  enabled: boolean | null;
  desired_spec: Record<string, unknown> | null;
  reported_spec: Record<string, unknown> | null;
  reported_state: AutomationReportedState | null;
  sync_status: AutomationSyncStatus;
  sync_error: string | null;
  spec_hash: string | null;
  gateway_job_id: string | null;
  desired_generation: number;
  observed_generation: number | null;
  /** Run-now: ``run_requested_generation > run_observed_generation`` ⇒ a run is
   *  queued for the agent to execute on its next reconcile. */
  run_requested_generation: number;
  run_observed_generation: number;
  run_pending: boolean;
  schema_version: string;
  openclaw_version: string | null;
  plugin_version: string | null;
  last_reported_at: string | null;
  last_seen_at: string | null;
  missing_since: string | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface AutomationRun {
  id: number;
  automation_id: string;
  gateway_job_id: string | null;
  gateway_run_id: string | null;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
  summary: Record<string, unknown> | null;
  diagnostics: Record<string, unknown> | null;
  created_at: string | null;
}

/** Every automation across the org's agents the caller operates. */
export async function listOrgAutomations(
  orgId: string,
): Promise<{ automations: Automation[] }> {
  if (!orgId) throw new Error("orgId is required");
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/automations`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<{ automations: Automation[] }>;
}

/** One agent's automations (operator-only). */
export async function listAgentAutomations(
  orgId: string,
  agentId: string,
): Promise<{ automations: Automation[] }> {
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/automations`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<{ automations: Automation[] }>;
}

export async function createAutomation(
  orgId: string,
  agentId: string,
  desiredSpec: Record<string, unknown>,
): Promise<Automation> {
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/automations`,
    {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ desired_spec: desiredSpec }),
    },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<Automation>;
}

export async function updateAutomation(
  orgId: string,
  agentId: string,
  automationId: string,
  desiredSpec: Record<string, unknown>,
): Promise<Automation> {
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/automations/${encodeURIComponent(automationId)}`,
    {
      credentials: "include",
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ desired_spec: desiredSpec }),
    },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<Automation>;
}

export async function deleteAutomation(
  orgId: string,
  agentId: string,
  automationId: string,
): Promise<{ automation_id: string; status: string }> {
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/automations/${encodeURIComponent(automationId)}`,
    { credentials: "include", method: "DELETE" },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<{ automation_id: string; status: string }>;
}

/** Request an immediate one-off run of a managed automation. The agent runs the
 *  job on its next reconcile (seconds, via the sync nudge). */
export async function runAutomation(
  orgId: string,
  agentId: string,
  automationId: string,
): Promise<Automation> {
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/automations/${encodeURIComponent(automationId)}/run`,
    { credentials: "include", method: "POST" },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<Automation>;
}

export async function listAutomationRuns(
  orgId: string,
  agentId: string,
  automationId: string,
): Promise<{ runs: AutomationRun[] }> {
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/automations/${encodeURIComponent(automationId)}/runs`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<{ runs: AutomationRun[] }>;
}

/** A channel/DM the agent is a member of — a pickable automation delivery
 *  target. The agent can post to any of these. */
export interface AgentDeliveryChannel {
  channel_id: string;
  name: string;
  display_name: string | null;
  channel_type: MmChannelType;
}

/** Channels + DMs the agent belongs to (operator-only), for the delivery-target
 *  picker. */
export async function listAgentChannels(
  orgId: string,
  agentId: string,
): Promise<{ channels: AgentDeliveryChannel[] }> {
  const res = await fetch(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/channels`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await extractError(res));
  return res.json() as Promise<{ channels: AgentDeliveryChannel[] }>;
}

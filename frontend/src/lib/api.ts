export interface AvatarRef {
  url: string;
  version: number;
  kind: "generated" | "uploaded";
}

export interface HumanUser {
  id: number;
  email: string;
  display_name?: string;
  avatar?: AvatarRef | null;
  created_at?: string | null;
  last_seen_at?: string | null;
}

export interface PrivacySettings {
  last_seen_visible: boolean;
  online_status_visible: boolean;
  read_receipts_enabled: boolean;
  typing_indicators_enabled: boolean;
}

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
  last_alive_at?: string | null;
  operator?: AgentOperator | null;
  file_count?: number;
  description?: string | null;
  description_regen_pending?: boolean;
  /** "default" | "auto" | "manual" */
  description_source?: string | null;
  inter_agent_mode_enabled?: boolean;
  snoozed?: boolean;
  inter_agent_message_limit?: number;
  is_operator?: boolean;
  can_dm?: boolean;
  can_tag?: boolean;
  can_manage_contacts?: boolean;
  avatar?: AvatarRef | null;
  reef_host?: string | null;
  reef_name?: string | null;
  agent_type?: string | null;
  plugin_version?: string | null;
}

/** Kelp and Vent ship as finishes but are out of the ladder until more marks exist. */
export type TidemarkTier =
  | "shore" | "swell" | "tide" | "reef" | "nacre" | "twilight" | "kelp" | "vent" | "abyss" | "hadal";

export type TidemarkBandId = "shallows" | "open" | "deep";

export type TidemarkKind =
  | "conversation" | "channel" | "lobstertalk" | "automation" | "mail" | "teamwork"
  | "file" | "skill" | "run" | "thread" | "pinned" | "crew" | "night" | "handoff"
  | "streak3" | "streak7" | "streak30" | "clockwork" | "tides" | "weathered" | "year";

export interface Tidemarks {
  tier: TidemarkTier;
  tiers: { id: TidemarkTier; marks: number }[];
  bands: { id: TidemarkBandId; kinds: TidemarkKind[] }[];
  marks: { kind: TidemarkKind; earned_at: string | null; detail: string | null }[];
  full_set: boolean;
}

export interface AgentProfile extends AgentUser {
  tidemarks: Tidemarks;
  email_address?: string | null;
  bio?: string | null;
  location?: string | null;
  website?: string | null;
  header_url?: string | null;
  creation_time?: string;
  description_generated_at?: string | null;
  lobstertalk_enabled?: boolean;
  lobstertalk_ollama_host?: string | null;
  lobstertalk_ollama_model?: string | null;
  lobstertalk_interval_seconds?: number;
  lobstertalk_message_limit?: number;
}

export type OrgRole = "owner" | "member";

export function orgRoleLabel(role: OrgRole): string {
  return role === "owner" ? "Admin" : "Member";
}

export interface Org {
  org_id: string;
  name: string;
  display_name?: string;
  avatar?: AvatarRef | null;
  is_personal: boolean;
  created_at?: string;
  my_role?: OrgRole | null;
  last_visited_at?: string | null;
  unread_count?: number;
  unread_channel_count?: number;
  attention_enabled?: boolean;
  reef_connected?: boolean;
}

export interface OrgMember {
  human_id: number;
  email: string;
  display_name?: string;
  role: OrgRole;
  joined_at?: string;
  avatar?: AvatarRef | null;
}

interface OrgMembers {
  members: OrgMember[];
  total: number;
}

type Init = RequestInit & { detail?: boolean };

async function readDetail(res: Response): Promise<string> {
  const text = await res.text();
  const fallback = text || res.statusText || String(res.status);
  try {
    const { detail } = JSON.parse(text) as { detail?: unknown };
    return typeof detail === "string" && detail ? detail : fallback;
  } catch {
    return fallback;
  }
}

async function send(url: string, { detail, ...init }: Init = {}): Promise<Response> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) throw new Error(detail ? await readDetail(res) : await res.text());
  return res;
}

async function request<T>(url: string, init?: Init): Promise<T> {
  return (await send(url, init)).json() as Promise<T>;
}

async function deleteIfPresent(url: string): Promise<void> {
  const res = await fetch(url, { credentials: "include", method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(await readDetail(res));
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function withQuery(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function orgUrl(orgId: string, path = ""): string {
  if (!orgId) throw new Error("orgId is required");
  return `/api/human/orgs/${encodeURIComponent(orgId)}${path}`;
}

function agentUrl(orgId: string, agentId: string, path = ""): string {
  const agents = orgUrl(orgId, "/agents/");
  if (!agentId) throw new Error("agentId is required");
  return `${agents}${encodeURIComponent(agentId)}${path}`;
}

function channelUrl(channelId: string, path = ""): string {
  return `/api/human/mm/channels/${encodeURIComponent(channelId)}${path}`;
}

function postUrl(postId: number, path = ""): string {
  return `/api/human/mm/posts/${encodeURIComponent(String(postId))}${path}`;
}

function fileUrl(fileId: string, path = ""): string {
  return `/api/human/mm/files/${encodeURIComponent(fileId)}${path}`;
}

export type OAuthProvider = "google" | "github";

export function socialAuthUrl(provider: OAuthProvider): string {
  return `/api/auth/social/${provider}/start`;
}

export async function sendMagicCode(email: string) {
  await send("/api/auth/magic/send", json("POST", { email }));
}

export async function verifyMagicCode(email: string, code: string) {
  return request<HumanUser>("/api/auth/magic/verify", json("POST", { email, code }));
}

export async function verifySocialEmail(code: string) {
  return request<HumanUser>("/api/auth/social/verify-email", json("POST", { code }));
}

export async function logout() {
  await fetch("/api/auth/logout", { credentials: "include", method: "POST" });
}

export async function getMe() {
  return request<HumanUser>("/api/auth/me");
}

export async function updateMyProfile(displayName: string | null) {
  return request<HumanUser>("/api/human/me", json("PATCH", { display_name: displayName }));
}

export async function getPrivacySettings() {
  return request<PrivacySettings>("/api/human/privacy-settings");
}

export async function updatePrivacySettings(patch: Partial<PrivacySettings>) {
  return request<PrivacySettings>("/api/human/privacy-settings", json("PATCH", patch));
}

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

export interface ConnectorsList {
  connectors: Connector[];
}

export type ConnectResult =
  | { status: "connected"; connector: Connector; url?: null }
  | { status: "redirect"; url: string; connector?: null };

export async function getConnectors() {
  return request<ConnectorsList>("/api/human/connectors");
}

export async function connectProvider(provider: string) {
  return request<ConnectResult>(`/api/human/connectors/${encodeURIComponent(provider)}/connect`, {
    method: "POST",
  });
}

export async function disconnectProvider(provider: string) {
  await send(`/api/human/connectors/${encodeURIComponent(provider)}`, { method: "DELETE" });
}

export async function getVapidPublicKey() {
  const { key } = await request<{ key: string | null }>("/api/push/vapid-public-key");
  return key ?? null;
}

export async function subscribeWebPush(subscription: PushSubscriptionJSON) {
  await send("/api/push/web/subscribe", json("POST", subscription));
}

export async function unsubscribeWebPush(endpoint: string) {
  await send("/api/push/web/unsubscribe", json("POST", { endpoint }));
}

export async function uploadOwnAvatar(file: File | Blob) {
  const body = new FormData();
  body.append("file", file);
  return request<AvatarRef>("/api/human/avatars/users/me/upload", { method: "POST", body });
}

export async function resetOwnAvatar() {
  return request<AvatarRef>("/api/human/avatars/users/me", { method: "DELETE" });
}

export async function updateOrg(orgId: string, displayName: string) {
  return request<Org>(orgUrl(orgId), { ...json("PATCH", { display_name: displayName }), detail: true });
}

export async function uploadOrgAvatar(orgId: string, file: Blob) {
  const body = new FormData();
  body.append("file", file);
  return request<AvatarRef>(`/api/human/avatars/orgs/${encodeURIComponent(orgId)}/upload`, { method: "POST", body, detail: true });
}

export async function removeOrgAvatar(orgId: string) {
  await send(`/api/human/avatars/orgs/${encodeURIComponent(orgId)}`, { method: "DELETE", detail: true });
}

export async function getOrgs() {
  return request<{ organizations: Org[]; total: number }>("/api/human/orgs");
}

export async function createOrg(name: string, displayName?: string) {
  return request<Org>("/api/human/orgs", json("POST", { name, display_name: displayName ?? null }));
}

export async function markOrgVisited(orgId: string) {
  await send(orgUrl(orgId, "/visit"), { method: "POST" });
}

export async function listOrgMembers(orgId: string) {
  return request<OrgMembers>(orgUrl(orgId, "/members"));
}

export async function addOrgMember(orgId: string, email: string, role: OrgRole = "member") {
  return request<OrgMembers>(orgUrl(orgId, "/members"), json("POST", { email, role }));
}

export async function updateOrgMemberRole(orgId: string, memberId: number, role: OrgRole) {
  return request<OrgMembers>(orgUrl(orgId, `/members/${String(memberId)}`), json("PATCH", { role }));
}

export async function removeOrgMember(orgId: string, memberId: number) {
  return request<OrgMembers>(orgUrl(orgId, `/members/${String(memberId)}`), { method: "DELETE" });
}

export interface ReefHost {
  host: string;
  reef: string | null;
  last_seen: string | null;
  health: "live" | "stale" | "failing";
  error: string | null;
  agents: ReefHostAgent[];
  events: ReefEvent[];
}

export interface ReefHostAgent {
  name: string;
  role: string;
  image: string;
  state: string;
  vm: string | null;
  synced: boolean;
  role_current: boolean;
}

export interface ReefEvent {
  agent: string;
  at: string;
  kind: string;
  detail: string;
}

export interface Reef {
  repo: string | null;
  connected: boolean;
  hosts: ReefHost[];
  declared: ReefDeclaredAgent[];
}

export interface ReefDeclaredAgent {
  host: string;
  name: string;
  expires_at: string;
}

export interface ReefCreatedAgent extends ReefDeclaredAgent {
  agent_id: string;
  nickname: string;
}

export interface ReefRole {
  name: string;
  image: string;
  resources: Record<string, number>;
}

export async function getReef(orgId: string) {
  return request<Reef>(orgUrl(orgId, "/reef"), { detail: true });
}

export async function setReef(orgId: string, repo: string, token: string) {
  return request<Reef>(orgUrl(orgId, "/reef"), { ...json("PUT", { repo, token }), detail: true });
}

export async function deleteReef(orgId: string) {
  await send(orgUrl(orgId, "/reef"), { method: "DELETE", detail: true });
}

export async function listReefRoles(orgId: string) {
  return request<ReefRole[]>(orgUrl(orgId, "/reef/roles"), { detail: true });
}

export async function createReefAgent(orgId: string, body: { host: string; role: string }) {
  return request<ReefCreatedAgent>(orgUrl(orgId, "/reef/agents"), { ...json("POST", body), detail: true });
}

export async function deleteReefAgent(orgId: string, host: string, name: string) {
  await send(orgUrl(orgId, `/reef/agents/${encodeURIComponent(host)}/${encodeURIComponent(name)}`), {
    method: "DELETE",
    detail: true,
  });
}

export interface OrgLobstertalkSettings {
  enabled: boolean;
  mode: "embedding" | "cascade" | "llm_only" | "all";
  base_url: string | null;
  model: string | null;
  api_key_set: boolean;
  cooldown_seconds: number | null;
  default_cooldown_seconds: number;
}

export interface SetOrgLobstertalkBody {
  enabled: boolean;
  mode: OrgLobstertalkSettings["mode"];
  base_url?: string | null;
  model?: string | null;
  /** Omit to keep the stored key. */
  api_key?: string;
  clear_api_key?: boolean;
  /** Whole-state: omitting it clears the override. */
  cooldown_seconds?: number | null;
}

export interface OrgLobstertalkHealth {
  ok: boolean;
  detail: string;
  latency_ms: number;
}

export async function getOrgLobstertalk(orgId: string) {
  return request<OrgLobstertalkSettings>(orgUrl(orgId, "/lobstertalk"), { detail: true });
}

export async function setOrgLobstertalk(orgId: string, body: SetOrgLobstertalkBody) {
  return request<OrgLobstertalkSettings>(orgUrl(orgId, "/lobstertalk"), { ...json("PUT", body), detail: true });
}

export async function checkOrgLobstertalkEndpoint(orgId: string) {
  return request<OrgLobstertalkHealth>(orgUrl(orgId, "/lobstertalk/healthcheck"), {
    method: "POST",
    detail: true,
  });
}

export async function setOrgLobstertalkChannel(orgId: string, channelId: string, approved: boolean) {
  return request<{ channel_id: string; lobstertalk_approved: boolean }>(
    orgUrl(orgId, `/lobstertalk/channels/${encodeURIComponent(channelId)}`),
    { ...json("PUT", { approved }), detail: true },
  );
}

export type AgentSignupStatus = "pending_approval" | "approved" | "rejected";

export interface AgentSignupSession {
  session_token: string;
  challenge: string;
  agent_id: string;
  nickname: string;
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

export interface PluginVersionCheck {
  supported: boolean;
  plugin_version: string | null;
  min_plugin_version: string;
  message: string | null;
}

export async function checkPluginVersion(
  pluginKind: "openclaw" | "ironclaw" | "hermes",
  pluginVersion: string,
) {
  return request<PluginVersionCheck>("/api/agentic/version-check", {
    credentials: "same-origin",
    headers: { "X-Clawbits-Plugin-Kind": pluginKind, "X-Clawbits-Plugin-Version": pluginVersion },
    detail: true,
  });
}

export async function startHumanAgentSignup(orgId: string) {
  if (!orgId) throw new Error("orgId is required");
  return request<AgentSignupSession>("/api/human/agent_signup", json("POST", { org_id: orgId }));
}

export async function listOrgSignupRequests(orgId: string) {
  return request<{ requests: AgentSignupRequest[] }>(orgUrl(orgId, "/signup-requests"));
}

export async function approveAgentSignupRequest(orgId: string, requestId: string) {
  return request<AgentSignupRequest>(
    orgUrl(orgId, `/signup-requests/${encodeURIComponent(requestId)}/approve`),
    { method: "POST" },
  );
}

export async function rejectAgentSignupRequest(orgId: string, requestId: string) {
  return request<AgentSignupRequest>(
    orgUrl(orgId, `/signup-requests/${encodeURIComponent(requestId)}/reject`),
    { method: "POST" },
  );
}

export async function removeAgentFromOrg(orgId: string, agentId: string, keepContent = false) {
  return request<{ agent_id: string; org_id: string; deleted: boolean }>(
    agentUrl(orgId, agentId, keepContent ? "?keep_content=true" : ""),
    { method: "DELETE" },
  );
}

export async function deleteMyAccount() {
  await send("/api/human/account", { method: "DELETE", detail: true });
}

export async function getAgents(orgId: string) {
  return request<{ agents: AgentUser[]; total?: number }>(orgUrl(orgId, "/agents"));
}

export type UsageRange = "day" | "week" | "month" | "all";

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  call_count: number;
}

export interface OrgUsageAgentRow extends UsageTotals {
  agent_id: string;
  nickname?: string | null;
  display_name?: string | null;
  reporting: boolean;
  top_models: string[];
}

export interface UsageModelRow extends UsageTotals {
  model: string;
  provider?: string | null;
}

export interface UsageDay extends UsageTotals {
  date: string;
  by_agent?: Record<string, number>;
}

export interface OrgUsageResponse {
  schema_version: string;
  range: UsageRange;
  role: "owner" | "member";
  org_total: UsageTotals;
  daily: UsageDay[];
  per_agent?: OrgUsageAgentRow[];
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

export async function getOrgUsage(orgId: string, opts: { range: UsageRange; groupBy?: "agent" | "model" }) {
  const params = new URLSearchParams({ range: opts.range });
  if (opts.groupBy) params.set("group_by", opts.groupBy);
  return request<OrgUsageResponse>(orgUrl(orgId, `/usage?${params.toString()}`));
}

export async function getAgentUsage(orgId: string, agentId: string, opts: { range: UsageRange }) {
  return request<AgentUsageResponse>(agentUrl(orgId, agentId, `/usage?range=${encodeURIComponent(opts.range)}`));
}

export async function getAgentProfile(orgId: string, agentId: string) {
  return request<AgentProfile>(agentUrl(orgId, agentId));
}

export type ContactPrincipalType = "human" | "agent";

export interface ContactPermissionEntry {
  principal_type: ContactPrincipalType;
  principal_id: string;
  display_name?: string | null;
  can_dm: boolean;
  can_tag: boolean;
}

export async function listAgentContactPermissions(agentId: string) {
  return request<{ agent_id: string; permissions: ContactPermissionEntry[] }>(
    `/api/human/agents/${encodeURIComponent(agentId)}/contact-permissions`,
  );
}

export async function setAgentContactPermission(
  agentId: string,
  principalType: ContactPrincipalType,
  principalId: string,
  perms: { can_dm: boolean; can_tag: boolean },
) {
  return request<ContactPermissionEntry>(
    `/api/human/agents/${encodeURIComponent(agentId)}/contact-permissions`,
    json("PUT", {
      principal_type: principalType,
      principal_id: principalId,
      can_dm: perms.can_dm,
      can_tag: perms.can_tag,
    }),
  );
}

export interface EmailSummary {
  uid: number;
  from_addr: string;
  to_addr: string;
  subject: string;
  date: string;
  is_read: boolean;
  size: number;
  snippet?: string | null;
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

export async function getAgentInboxCount(orgId: string, agentId: string) {
  return request<AgentInboxCount>(agentUrl(orgId, agentId, "/email/count"), { detail: true });
}

export async function getAgentInbox(orgId: string, agentId: string, limit: number) {
  return request<AgentInbox>(agentUrl(orgId, agentId, `/email/inbox?limit=${String(limit)}`), { detail: true });
}

export async function setAgentEmailRead(orgId: string, agentId: string, uid: number, read: boolean) {
  return request<{ status: string; is_read: boolean }>(agentUrl(orgId, agentId, `/email/${String(uid)}`), {
    ...json("PATCH", { is_read: read }),
    detail: true,
  });
}

export async function getAgentEmail(orgId: string, agentId: string, uid: number) {
  return request<EmailDetail>(agentUrl(orgId, agentId, `/email/${String(uid)}`), { detail: true });
}

export async function deleteAgentEmail(orgId: string, agentId: string, uid: number) {
  return request<{ status: string }>(agentUrl(orgId, agentId, `/email/${String(uid)}`), {
    method: "DELETE",
    detail: true,
  });
}

export type MmChannelType = "public" | "private" | "direct" | "agent_chat";

export type MmPostStatus = "streaming" | "draft" | "published" | "rejected";

export interface MmChannel {
  channel_id: string;
  org_id?: string | null;
  name: string;
  display_name?: string | null;
  channel_type: MmChannelType;
  created_by_human?: number | null;
  created_by_agent?: string | null;
  created_at: string;
  last_message_at?: string | null;
  unread_count?: number;
  /** Client-only: set from the streaming placeholder, never fetched. */
  working?: boolean;
  unread_mention_count?: number;
  muted?: boolean;
  pinned?: boolean;
  last_message_text?: string | null;
  last_message_author_human_id?: number | null;
  last_message_author_agent_id?: string | null;
  last_message_author_display_name?: string | null;
  last_message_author_avatar?: AvatarRef | null;
  last_message_attachment_count?: number | null;
  dm_peer_human_id?: number | null;
  dm_peer_agent_id?: string | null;
  dm_peer?: MmChannelMember | null;
  avatar?: AvatarRef | null;
}

export interface MmPostParentPreview {
  post_id: number;
  agent_id: string | null;
  human_id: number | null;
  poster_display_name: string | null;
  message_excerpt: string;
  status: MmPostStatus;
  attachment_count?: number;
}

export interface MmPostReaction {
  emoji: string;
  count: number;
  human_ids: number[];
  agent_ids: string[];
}

export type MmFileStatus = "pending" | "uploaded" | "failed" | "deleted";

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
  download_url_expires_at?: number | null;
  thumbnail_url?: string | null;
  thumbnail_url_expires_at?: number | null;
  uploader_human_id?: number | null;
  uploader_agent_id?: string | null;
  post_id?: number | null;
}

export type MmAttachmentKind = "image" | "video" | "media" | "file" | "all";

export interface MmFileListResponse {
  files: MmFile[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
  offset: number | null;
  total: number | null;
}

export interface ListChannelAttachmentsParams {
  kind?: MmAttachmentKind;
  /** Exact MIME, or a prefix ending in "/". Overrides `kind`. */
  contentType?: string;
  limit?: number;
  beforeFileId?: string;
  offset?: number;
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
  next_cursor: number | null;
  offset: number | null;
}

export interface ListChannelLinksParams {
  limit?: number;
  beforePostId?: number;
  offset?: number;
}

export interface MmChannelPost {
  post_id: number;
  channel_id: string;
  agent_id: string | null;
  human_id: number | null;
  poster_display_name: string | null;
  avatar?: AvatarRef | null;
  message: string;
  created_at: string;
  status: MmPostStatus;
  updated_at?: string | null;
  published_at?: string | null;
  edited_at?: string | null;
  pinned_at?: string | null;
  pinned_by_human_id?: number | null;
  parent_post_id?: number | null;
  parent_preview?: MmPostParentPreview | null;
  link_preview?: MmPostLinkPreviewEmbedded | null;
  reactions?: MmPostReaction[];
  files?: MmFile[];
  /** Echoed only on the create response and post.created, never on reads. */
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

export async function listDiscoverableMmChannels(orgId: string) {
  return request<{ channels: MmDiscoverableChannel[]; total: number }>(
    `/api/human/mm/channels/discoverable?org_id=${encodeURIComponent(orgId)}`,
  );
}

export async function joinMmChannel(channelId: string) {
  return request<MmChannel>(channelUrl(channelId, "/join"), { method: "POST" });
}

export interface MmAdminChannel {
  channel_id: string;
  org_id: string | null;
  name: string;
  display_name?: string | null;
  channel_type: Exclude<MmChannelType, "direct" | "agent_chat">;
  created_at: string;
  created_by_human?: number | null;
  last_message_at?: string | null;
  last_message_text?: string | null;
  member_count: number;
  avatar?: AvatarRef | null;
  lobstertalk_approved: boolean;
}

export async function listAllOrgChannels(orgId: string) {
  return request<{ channels: MmAdminChannel[]; total: number }>(
    `/api/human/mm/orgs/${encodeURIComponent(orgId)}/channels`,
  );
}

export async function deleteMmChannel(channelId: string) {
  await send(channelUrl(channelId), { method: "DELETE" });
}

export async function listMmChannels(orgId?: string | null) {
  return request<{ channels: MmChannel[]; total: number }>(
    orgId ? `/api/human/mm/channels?org_id=${encodeURIComponent(orgId)}` : "/api/human/mm/channels",
  );
}

export async function getMmChannel(channelId: string) {
  return request<MmChannel>(channelUrl(channelId));
}

export async function createMmChannel(
  orgId: string,
  name: string,
  displayName?: string,
  channelType: "public" | "private" = "public",
) {
  if (!orgId) throw new Error("Organization is required");
  return request<MmChannel>(
    "/api/human/mm/channels",
    json("POST", { org_id: orgId, name, display_name: displayName ?? null, channel_type: channelType }),
  );
}

export async function createOrGetMmDirect(orgId: string, targetType: "agent" | "human", targetId: string) {
  return request<MmChannel>(
    "/api/human/mm/direct",
    json("POST", { org_id: orgId, target_type: targetType, target_id: targetId }),
  );
}

export async function createMmAgentChat(orgId: string, agentId: string) {
  return request<MmChannel>(
    "/api/human/mm/agent-chats",
    json("POST", { org_id: orgId, agent_id: agentId }),
  );
}

export async function patchMmChannel(channelId: string, displayName: string) {
  return request<MmChannel>(channelUrl(channelId), json("PATCH", { display_name: displayName }));
}

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
  /** Matches wrapped in <mark>, the rest HTML-escaped server-side. */
  snippet: string;
  rank: number;
}

export interface MmSearchResponse {
  results: MmSearchResult[];
  next_cursor: string | null;
  query: string;
  sort: string;
}

export interface MmSearchFilters {
  channelId?: string;
  fromHumanId?: number;
  fromAgentId?: string;
  before?: string;
  after?: string;
  hasLink?: boolean;
  hasFile?: boolean;
}

export interface SearchMessagesParams extends MmSearchFilters {
  orgId: string | null;
  query: string;
  sort: MmSearchSort;
  cursor: string | null;
  limit: number;
}

export async function searchMessages(params: SearchMessagesParams) {
  const qs = new URLSearchParams();
  qs.set("q", params.query);
  if (params.orgId) qs.set("org_id", params.orgId);
  if (params.channelId) qs.set("channel_id", params.channelId);
  qs.set("sort", params.sort);
  qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.fromHumanId != null) qs.set("from_human_id", String(params.fromHumanId));
  if (params.fromAgentId) qs.set("from_agent_id", params.fromAgentId);
  if (params.before) qs.set("before", params.before);
  if (params.after) qs.set("after", params.after);
  if (params.hasLink) qs.set("has_link", "true");
  if (params.hasFile) qs.set("has_file", "true");
  return request<MmSearchResponse>(`/api/human/mm/search?${qs.toString()}`);
}

export interface MmPostListPayload {
  posts: MmChannelPost[];
  total: number;
  limit: number;
  offset: number;
}

// The API answers no-store, so revalidation is driven here with If-None-Match.
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
  if (afterPostId != null) params.set("after_post_id", String(afterPostId));
  const url = channelUrl(channelId, `/posts?${params.toString()}`);
  const cached = postListEtagCache.get(url);
  const res = await fetch(url, {
    credentials: "include",
    headers: cached ? { "If-None-Match": cached.etag } : {},
  });
  if (res.status === 304 && cached) return cached.data;
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as MmPostListPayload;
  const etag = res.headers.get("ETag");
  if (etag) postListEtagCache.set(url, { etag, data });
  return data;
}

export async function listMmPostsAround(channelId: string, postId: number, radius = 25) {
  return request<MmPostListPayload>(
    channelUrl(channelId, `/posts/around/${encodeURIComponent(String(postId))}?radius=${String(radius)}`),
  );
}

export interface MmChannelEvent {
  event_id: number;
  channel_id: string;
  event_type: string;
  actor_human_id: number | null;
  actor_agent_id: string | null;
  actor_display_name: string | null;
  actor_avatar: AvatarRef | null;
  /** Null when the actor acted on themselves ("joined", not "added X"). */
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

export async function listMmChannelEvents(channelId: string, limit = 100) {
  // Not `/events`: that path is the channel's SSE stream.
  return request<MmChannelEventListPayload>(channelUrl(channelId, `/inline-events?limit=${String(limit)}`));
}

export interface MmMarkReadResponse {
  channel_id: string;
  last_read_post_id: number;
}

export async function markMmChannelRead(channelId: string, postId: number) {
  return request<MmMarkReadResponse>(channelUrl(channelId, "/read"), json("POST", { post_id: postId }));
}

export interface MmMuteResponse {
  channel_id: string;
  muted: boolean;
}

export interface MmPinResponse {
  channel_id: string;
  pinned: boolean;
}

export async function getDevAuthEnabled() {
  try {
    const res = await fetch("/api/auth/dev/enabled", { credentials: "include" });
    return res.ok && ((await res.json()) as { enabled: boolean }).enabled;
  } catch {
    return false;
  }
}

export async function devLogin(email: string, displayName?: string) {
  return request<HumanUser>("/api/auth/dev/login", json("POST", { email, display_name: displayName ?? null }));
}

export async function setMmChannelMuted(channelId: string, muted: boolean) {
  return request<MmMuteResponse>(channelUrl(channelId, "/mute"), json("POST", { muted }));
}

export async function setMmChannelPinned(channelId: string, pinned: boolean) {
  return request<MmPinResponse>(channelUrl(channelId, "/pin"), json("POST", { pinned }));
}

export async function exportMmChannel(channelId: string) {
  const res = await send(channelUrl(channelId, "/export"));
  return { blob: await res.blob(), disposition: res.headers.get("Content-Disposition") };
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
    /** An empty string clears the host or model. */
    lobstertalk_ollama_host?: string;
    lobstertalk_ollama_model?: string;
    lobstertalk_interval_seconds?: number;
    lobstertalk_message_limit?: number;
  },
) {
  return request<AgentSettingsResponse>(agentUrl(orgId, agentId, "/settings"), json("PATCH", settings));
}

export async function renameAgent(orgId: string, agentId: string, nickname: string) {
  return request<{ agent_id: string; nickname: string }>(
    agentUrl(orgId, agentId, "/name"),
    json("PATCH", { nickname }),
  );
}

export async function regenerateAgentDescription(orgId: string, agentId: string) {
  return request<{ agent_id: string; description_regen_pending: boolean }>(
    agentUrl(orgId, agentId, "/description/regenerate"),
    { method: "POST" },
  );
}

export async function setAgentDescription(orgId: string, agentId: string, description: string) {
  return request<{ agent_id: string; description: string; description_source: string }>(
    agentUrl(orgId, agentId, "/description"),
    json("PATCH", { description }),
  );
}

export async function sendMmTypingHeartbeat(channelId: string) {
  await fetch(channelUrl(channelId, "/typing"), { credentials: "include", method: "POST" });
}

export async function stopAgentTurn(channelId: string, agentId: string) {
  await send(channelUrl(channelId, `/agents/${encodeURIComponent(agentId)}/stop`), {
    method: "POST",
    detail: true,
  });
}

export type GlobalUserStatus = "online" | "idle" | "offline";

export type AgentLivenessStatus = "setup" | "available" | "offline";

export async function sendGlobalPresenceHeartbeat(status: GlobalUserStatus, options?: { keepalive?: boolean }) {
  await fetch("/api/human/presence", {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
    keepalive: options?.keepalive,
  });
}

export type MmMemberType = "agent" | "human";

export interface MmChannelMember {
  agent_id: string | null;
  human_id: number | null;
  display_name: string | null;
  joined_at: string;
  status: GlobalUserStatus | null;
  last_seen_at: string | null;
  /** Set instead of `last_seen_at` when the member hides it. */
  last_seen_label?: string | null;
  avatar?: AvatarRef | null;
  last_read_post_id?: number | null;
  agent_status?: AgentLivenessStatus | null;
  last_alive_at?: string | null;
  /** Null means allowed. */
  can_tag?: boolean | null;
  can_stop?: boolean;
  is_operator?: boolean;
  model_choice?: ModelChoice | null;
}

export interface MmChannelMembersResponse {
  members: MmChannelMember[];
  total: number;
  channel_deleted?: boolean;
}

export async function listMmChannelMembers(channelId: string) {
  return request<MmChannelMembersResponse>(channelUrl(channelId, "/members"));
}

export async function addMmChannelMember(channelId: string, memberId: string, memberType: MmMemberType) {
  return request<MmChannelMembersResponse>(
    channelUrl(channelId, "/members"),
    json("POST", { member_id: memberId, member_type: memberType }),
  );
}

export async function removeMmChannelMember(channelId: string, memberId: string, memberType: MmMemberType) {
  return request<MmChannelMembersResponse>(
    channelUrl(channelId, `/members/${encodeURIComponent(memberId)}?member_type=${memberType}`),
    { method: "DELETE" },
  );
}

export async function leaveMmChannel(channelId: string, humanId: number) {
  return removeMmChannelMember(channelId, String(humanId), "human");
}

export async function editMmChannelPost(postId: number, message: string) {
  return request<MmChannelPost>(postUrl(postId), json("PATCH", { message }));
}

export async function deleteMmChannelPost(postId: number) {
  await deleteIfPresent(postUrl(postId));
}

export async function toggleMmPostReaction(postId: number, emoji: string) {
  return request<MmChannelPost>(postUrl(postId, "/reactions"), json("POST", { emoji }));
}

export async function pinMmPost(postId: number) {
  return request<MmChannelPost>(postUrl(postId, "/pin"), { method: "POST", detail: true });
}

export async function unpinMmPost(postId: number) {
  return request<MmChannelPost>(postUrl(postId, "/pin"), { method: "DELETE", detail: true });
}

export async function listPinnedMmPosts(channelId: string) {
  return request<{ posts: MmChannelPost[]; total: number }>(channelUrl(channelId, "/pins"), { detail: true });
}

export async function createMmChannelPost(
  channelId: string,
  message: string,
  parentPostId?: number | null,
  fileIds?: string[],
  clientMsgUuid?: string,
) {
  const traceId = `tr_${crypto.randomUUID()}`;
  const body: {
    message: string;
    trace_id: string;
    parent_post_id?: number;
    file_ids?: string[];
    client_msg_uuid?: string;
  } = { message, trace_id: traceId };
  if (parentPostId != null) body.parent_post_id = parentPostId;
  if (fileIds?.length) body.file_ids = fileIds;
  if (clientMsgUuid) body.client_msg_uuid = clientMsgUuid;
  const startedAt = Date.now();
  const post = await request<MmChannelPost>(channelUrl(channelId, "/posts"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-clawbits-trace-id": traceId },
    body: JSON.stringify(body),
  });
  if (import.meta.env.DEV) {
    const endedAt = Date.now();
    const span = {
      trace_id: traceId,
      span: "frontend.send_post",
      subsystem: "frontend",
      dur_ms: endedAt - startedAt,
      t_start_ms: startedAt,
      t_end_ms: endedAt,
      channel_id: channelId,
      post_id: post.post_id,
      client_msg_uuid: clientMsgUuid ?? null,
    };
    console.debug(`[clawbits-trace] ${JSON.stringify(span)}`);
    void fetch("/api/trace/spans", json("POST", span)).catch(() => undefined);
  }
  return post;
}

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

export async function fetchLinkPreview(url: string) {
  return request<LinkPreviewData>("/api/human/mm/link-preview", json("POST", { url }));
}

export interface MmFileUploadRequest {
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256?: string;
  has_thumbnail?: boolean;
  /** Required with has_thumbnail: the presigned PUT pins Content-Length to it. */
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

export async function requestMmFileUpload(channelId: string, body: MmFileUploadRequest) {
  return request<MmFileUploadResponse>(channelUrl(channelId, "/files"), { ...json("POST", body), detail: true });
}

export async function confirmMmFileUpload(fileId: string, body: MmFileConfirmRequest) {
  return request<MmFile>(fileUrl(fileId, "/confirm"), { ...json("POST", body), detail: true });
}

export async function getMmFileDownloadUrl(fileId: string) {
  return request<{ url: string; expires_in: number; expires_at: number }>(fileUrl(fileId, "/url"), {
    detail: true,
  });
}

export async function deleteMmFile(fileId: string) {
  await deleteIfPresent(fileUrl(fileId));
}

export async function listChannelAttachments(channelId: string, params: ListChannelAttachmentsParams = {}) {
  const query = new URLSearchParams();
  if (params.kind) query.set("kind", params.kind);
  if (params.contentType) query.set("content_type", params.contentType);
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.beforeFileId) query.set("before_file_id", params.beforeFileId);
  if (params.offset) query.set("offset", String(params.offset));
  if (params.includeTotal) query.set("include_total", "true");
  return request<MmFileListResponse>(channelUrl(channelId, `/attachments${withQuery(query)}`), { detail: true });
}

export async function listChannelLinks(channelId: string, params: ListChannelLinksParams = {}) {
  const query = new URLSearchParams();
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.beforePostId != null) query.set("before_post_id", String(params.beforePostId));
  if (params.offset) query.set("offset", String(params.offset));
  return request<MmLinkListResponse>(channelUrl(channelId, `/links${withQuery(query)}`), { detail: true });
}

export type UploadProgress = (loaded: number, total: number) => void;

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

export type AutomationSyncStatus = "requested" | "applied" | "failed" | "removing";
export type AutomationManagedBy = "clawbits" | "external";

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

function automationUrl(orgId: string, agentId: string, automationId: string, path = ""): string {
  return agentUrl(orgId, agentId, `/automations/${encodeURIComponent(automationId)}${path}`);
}

export async function listAgentAutomations(orgId: string, agentId: string) {
  return request<{ automations: Automation[] }>(agentUrl(orgId, agentId, "/automations"), { detail: true });
}

export async function createAutomation(orgId: string, agentId: string, desiredSpec: Record<string, unknown>) {
  return request<Automation>(agentUrl(orgId, agentId, "/automations"), {
    ...json("POST", { desired_spec: desiredSpec }),
    detail: true,
  });
}

export async function updateAutomation(
  orgId: string,
  agentId: string,
  automationId: string,
  desiredSpec: Record<string, unknown>,
) {
  return request<Automation>(automationUrl(orgId, agentId, automationId), {
    ...json("PATCH", { desired_spec: desiredSpec }),
    detail: true,
  });
}

export async function deleteAutomation(orgId: string, agentId: string, automationId: string) {
  return request<{ automation_id: string; status: string }>(automationUrl(orgId, agentId, automationId), {
    method: "DELETE",
    detail: true,
  });
}

export async function runAutomation(orgId: string, agentId: string, automationId: string) {
  return request<Automation>(automationUrl(orgId, agentId, automationId, "/run"), { method: "POST", detail: true });
}

export async function listAutomationRuns(orgId: string, agentId: string, automationId: string) {
  return request<{ runs: AutomationRun[] }>(automationUrl(orgId, agentId, automationId, "/runs"), { detail: true });
}

export interface AgentDeliveryChannel {
  channel_id: string;
  name: string;
  display_name: string | null;
  channel_type: MmChannelType;
}

export async function listAgentChannels(orgId: string, agentId: string) {
  return request<{ channels: AgentDeliveryChannel[] }>(agentUrl(orgId, agentId, "/channels"), { detail: true });
}

export type SkillVisibility = "private" | "org" | "public";
export type SkillOrigin = "authored" | "forked" | "imported";
export type SkillRuntime = "openclaw" | "hermes" | "ironclaw";

interface SkillRequirements {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  os?: string[];
}

export interface SkillFile {
  path: string;
  content?: string;
  sha256: string;
  size_bytes: number;
}

export interface SkillManifest {
  name: string;
  description: string;
  version?: string;
  homepage?: string;
  emoji?: string;
  user_invocable?: boolean;
  disable_model_invocation?: boolean;
  runtimes?: SkillRuntime[];
  requires?: SkillRequirements;
  env_declarations?: { name: string; required: boolean; description?: string }[];
}

export interface SkillVersion {
  version_id: string;
  skill_id: string;
  version: string;
  content_hash: string;
  total_bytes: number;
  has_executable: boolean;
  changelog: string | null;
  schema_version: string;
  published_by: number | null;
  created_at: string | null;
  manifest?: SkillManifest;
  body_md?: string;
  files?: SkillFile[];
}

export interface Skill {
  skill_id: string;
  org_id: string;
  /** Must equal the frontmatter `name`, so it is fixed after create. */
  slug: string;
  display_name: string;
  summary: string;
  icon_emoji: string | null;
  visibility: SkillVisibility;
  origin: SkillOrigin;
  runtimes: SkillRuntime[];
  forked_from_skill_id: string | null;
  forked_from_version_id: string | null;
  latest_version_id: string | null;
  latest_version: string | null;
  content_hash: string | null;
  has_executable: boolean;
  is_draft: boolean;
  installed_agent_count: number;
  pending_agent_count: number;
  archived_at: string | null;
  created_by: number | null;
  created_at: string | null;
  updated_at: string | null;
  current_version?: SkillVersion | null;
}

export interface RenderedSkill {
  runtime: SkillRuntime;
  path: string;
  content: string;
  content_hash: string;
}

function skillUrl(orgId: string, skillId: string, path = ""): string {
  return orgUrl(orgId, `/skills/${encodeURIComponent(skillId)}${path}`);
}

export async function listOrgSkills(orgId: string) {
  return request<{ skills: Skill[] }>(orgUrl(orgId, "/skills"), { detail: true });
}

export async function getSkill(orgId: string, skillId: string) {
  return request<Skill>(skillUrl(orgId, skillId), { detail: true });
}

export async function createSkill(
  orgId: string,
  body: {
    slug: string;
    display_name: string;
    manifest: SkillManifest;
    body_md: string;
    files?: { path: string; content: string }[];
  },
) {
  return request<Skill>(orgUrl(orgId, "/skills"), { ...json("POST", body), detail: true });
}

export async function publishSkillVersion(
  orgId: string,
  skillId: string,
  body: {
    manifest: SkillManifest;
    body_md: string;
    files?: { path: string; content: string }[];
    changelog?: string;
  },
) {
  return request<SkillVersion>(skillUrl(orgId, skillId, "/versions"), { ...json("POST", body), detail: true });
}

export async function listSkillVersions(orgId: string, skillId: string) {
  return request<{ versions: SkillVersion[] }>(skillUrl(orgId, skillId, "/versions"), { detail: true });
}

export async function renderSkillVersion(
  orgId: string,
  skillId: string,
  versionId: string,
  runtime: SkillRuntime = "openclaw",
) {
  return request<RenderedSkill>(
    skillUrl(
      orgId,
      skillId,
      `/versions/${encodeURIComponent(versionId)}/render?runtime=${encodeURIComponent(runtime)}`,
    ),
    { detail: true },
  );
}

export async function forkSkill(orgId: string, skillId: string, body: { slug?: string; display_name?: string } = {}) {
  return request<Skill>(skillUrl(orgId, skillId, "/fork"), { ...json("POST", body), detail: true });
}

export async function deleteSkill(orgId: string, skillId: string) {
  return request<{ skill_id: string; deleted: boolean }>(skillUrl(orgId, skillId), {
    method: "DELETE",
    detail: true,
  });
}

export interface AgentSkill {
  install_id: string;
  agent_id: string;
  skill_id: string | null;
  slug: string;
  managed_by: "clawbits" | "external";
  name: string;
  description: string | null;
  sync_status: string;
  sync_error: string | null;
  enabled: boolean;
  reported_version: string | null;
  reported_path: string | null;
  reported_root: string | null;
  reported_source: string | null;
  eligible: boolean | null;
  model_visible: boolean | null;
  missing: SkillRequirements | null;
  last_seen_at: string | null;
  updated_at: string | null;
}

export interface AgentSkillsResponse {
  skills: AgentSkill[];
  sync: {
    report_mode: string | null;
    skills_root: string | null;
    scanned_roots: string[] | null;
    apply_mode: string | null;
    prompt_chars_observed: number | null;
    prompt_budget_observed: number | null;
    truncated: boolean;
    plugin_version: string | null;
    last_reported_at: string | null;
  };
}

export async function listAgentSkills(orgId: string, agentId: string) {
  return request<AgentSkillsResponse>(agentUrl(orgId, agentId, "/skills"), { detail: true });
}

export async function installAgentSkill(orgId: string, agentId: string, skillId: string) {
  return request<AgentSkillsResponse>(agentUrl(orgId, agentId, "/skills"), {
    ...json("POST", { skill_id: skillId }),
    detail: true,
  });
}

export async function uninstallAgentSkill(orgId: string, agentId: string, installId: string) {
  return request<AgentSkillsResponse>(agentUrl(orgId, agentId, `/skills/${encodeURIComponent(installId)}`), {
    method: "DELETE",
    detail: true,
  });
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max" | "ultra";

export interface ModelChoice {
  model: string | null;
  thinking: ThinkingLevel | null;
}

export interface ModelOption {
  ref: string;
  provider: string;
  name: string;
  levels: ThinkingLevel[];
  default_level: ThinkingLevel | null;
}

export interface AgentModels {
  models: ModelOption[] | null;
  runtime_default: ModelChoice | null;
  default: ModelChoice;
  reported_at: string | null;
}

export async function getAgentModels(orgId: string, agentId: string) {
  return request<AgentModels>(agentUrl(orgId, agentId, "/models"), { detail: true });
}

export async function setAgentModel(orgId: string, agentId: string, body: ModelChoice & { channel_id: string | null }) {
  return request<ModelChoice>(agentUrl(orgId, agentId, "/models"), { ...json("PUT", body), detail: true });
}

import type {
  Channel,
  McpConnectLink,
  Organization,
  Post,
  PostsPage,
  Recipient,
  User,
} from "./models";
import type { Widget, WidgetAction, WidgetKindName } from "./widgets";

export const apiUrl = (
  process.env.EXPO_PUBLIC_CLAWBITS_API_URL || "https://app.clawbits.ai"
).replace(/\/+$/, "");
export const channelPath = (id: string): string =>
  `/api/human/mm/channels/${encodeURIComponent(id)}`;
const widgetPath = (id: string): string => `/api/human/mm/widgets/${encodeURIComponent(id)}`;
export const auth: {
  refresh?: (previous: string, next: string) => Promise<void>;
} = {};

export async function receiveSession(
  headers: Headers,
  token?: string,
): Promise<void> {
  const next = headers.get("X-Clawbits-Session");
  if (token && next && next !== token) await auth.refresh?.(token, next);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  token?: string,
  body?: unknown,
  signal?: AbortSignal,
  method: "GET" | "POST" | "PATCH" | "DELETE" = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  });
  await receiveSession(response.headers, token);
  if (!response.ok) {
    const error: { detail?: unknown } = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      typeof error.detail === "string"
        ? error.detail
        : `Request failed (${response.status})`,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}

/** A file-only post omits `message`. The server accepts that. */
export function postBody(message: string, uuid: string, fileIds: string[]) {
  const body: {
    message?: string;
    client_msg_uuid: string;
    file_ids?: string[];
  } = { client_msg_uuid: uuid };
  if (message) body.message = message;
  if (fileIds.length) body.file_ids = fileIds;
  return body;
}

export function mcpConnectLinkId(url: string): string | undefined {
  try {
    return /^\/connect\/([0-9a-f]{32})$/.exec(new URL(url).pathname)?.[1];
  } catch {
    return undefined;
  }
}

export const api = {
  me: (token: string) => request<User>("/api/auth/me", token),
  /** The link's card, or null once the link is gone. */
  mcpConnectLink: (token: string, linkId: string) =>
    request<McpConnectLink>(`/api/human/mcp-oauth/links/${linkId}`, token).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }),
  claimMcpConnect: (token: string, linkId: string) =>
    request<{ url: string }>(`/api/human/mcp-oauth/links/${linkId}/claim`, token, { client: "mobile" }),
  completeMcpSignIn: (token: string, state: string, code: string) =>
    request<{ channel_id: string }>("/api/human/mcp-oauth/callback", token, { state, code }),
  organizations: (token: string, signal?: AbortSignal) =>
    request<{ organizations: Organization[] }>(
      "/api/human/orgs",
      token,
      undefined,
      signal,
    ),
  members: (token: string, org: string, signal?: AbortSignal) =>
    request<{ total: number }>(
      `/api/human/orgs/${encodeURIComponent(org)}/members`,
      token,
      undefined,
      signal,
    ),
  channels: (token: string, org: string, signal?: AbortSignal) =>
    request<{ channels: Channel[] }>(
      `/api/human/mm/channels?org_id=${encodeURIComponent(org)}`,
      token,
      undefined,
      signal,
    ),
  channel: (token: string, id: string, signal?: AbortSignal) =>
    request<Channel>(channelPath(id), token, undefined, signal),
  posts: (
    token: string,
    id: string,
    before: number | null,
    signal?: AbortSignal,
  ) =>
    request<PostsPage>(
      `${channelPath(id)}/posts?limit=50${before === null ? "" : `&before_post_id=${before}`}`,
      token,
      undefined,
      signal,
    ),
  send: (token: string, id: string, message: string, uuid: string, fileIds: string[] = []) =>
    request<Post>(`${channelPath(id)}/posts`, token, postBody(message, uuid, fileIds)),
  fileUrl: (token: string, fileId: string) =>
    request<{ url: string }>(`/api/human/mm/files/${encodeURIComponent(fileId)}/url`, token),
  read: (token: string, id: string, postId: number) =>
    request<{ last_read_post_id: number }>(`${channelPath(id)}/read`, token, {
      post_id: postId,
    }),
  direct: (token: string, org: string, target: Recipient) =>
    request<Channel>("/api/human/mm/direct", token, {
      org_id: org,
      target_id: target.id,
      target_type: target.kind,
    }),
  deleteAccount: (token: string) =>
    request<void>("/api/human/account", token, undefined, undefined, "DELETE"),
  /** The chat's games switch; either person in the chat may flip it. */
  setChatWidgets: (token: string, id: string, enabled: boolean) =>
    request<Channel>(channelPath(id), token, { widgets_enabled: enabled }, undefined, "PATCH"),
  widget: (token: string, id: string, signal?: AbortSignal) =>
    request<Widget>(widgetPath(id), token, undefined, signal),
  activeWidgets: (token: string, channel: string, signal?: AbortSignal) =>
    request<{ widgets: Widget[] }>(`${channelPath(channel)}/widgets`, token, undefined, signal),
  /** The caller's seat is drawn at random. */
  startWidget: (token: string, channel: string, kind: WidgetKindName) =>
    request<Widget>(`${channelPath(channel)}/widgets`, token, { kind }),
  /** `rev` is the rev the action was taken on; a newer one answers 409. */
  actOnWidget: (token: string, id: string, action: WidgetAction, rev: number) =>
    request<Widget>(`${widgetPath(id)}/actions`, token, { action, expected_rev: rev }),
};

export async function recipients(
  token: string,
  org: string,
  userId: number,
  signal?: AbortSignal,
): Promise<Recipient[]> {
  const path = `/api/human/orgs/${encodeURIComponent(org)}`;
  const [humans, agents] = await Promise.all([
    request<{
      members: {
        human_id: number;
        display_name: string | null;
        email: string;
        avatar: Recipient["avatar"];
      }[];
    }>(`${path}/members`, token, undefined, signal),
    request<{
      agents: {
        agent_id: string;
        nickname: string | null;
        display_name: string | null;
        can_dm: boolean;
        avatar: Recipient["avatar"];
      }[];
    }>(`${path}/agents`, token, undefined, signal),
  ]);
  return [
    ...humans.members
      .filter((human) => human.human_id !== userId)
      .map((human): Recipient => ({
        id: String(human.human_id),
        kind: "human",
        name: human.display_name || human.email,
        avatar: human.avatar,
      })),
    ...agents.agents
      .filter((agent) => agent.can_dm)
      .map((agent): Recipient => ({
        id: agent.agent_id,
        kind: "agent",
        name: agent.nickname || agent.display_name || agent.agent_id,
        avatar: agent.avatar,
      })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

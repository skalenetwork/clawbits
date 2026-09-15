import type {
  Channel,
  Organization,
  Post,
  PostsPage,
  Recipient,
  User,
} from "./models";

export const apiUrl = (
  process.env.EXPO_PUBLIC_CLAWBITS_API_URL || "https://app.clawbits.ai"
).replace(/\/+$/, "");
export const channelPath = (id: string): string =>
  `/api/human/mm/channels/${encodeURIComponent(id)}`;
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
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
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

export const api = {
  me: (token: string) => request<User>("/api/auth/me", token),
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
  send: (token: string, id: string, message: string, uuid: string) =>
    request<Post>(`${channelPath(id)}/posts`, token, {
      message,
      client_msg_uuid: uuid,
    }),
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

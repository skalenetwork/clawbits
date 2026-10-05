import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

type Identity = { orgId: string; agentId: string; apiKey: string; channelId: string };
type Json = Record<string, unknown>;
type Config = { channels?: { clawbits?: { accounts?: Record<string, Partial<Identity>> } } };
type Enrolled = { agent_id: string; api_key: string; channel_id?: string };
type AgentInfo = { operator_display_name?: string | null };

const CONFIG = process.env.OPENCLAW_CONFIG_PATH ?? "/home/node/.openclaw/openclaw.json";
const MIRROR = "/home/node/.openclaw/state/clawbits-identity";
const DEFAULTS = "/usr/local/share/clawbits-defaults.json";
const OVERRIDE = "/etc/openclaw/defaults.json";
const ACCOUNT = "default";

const readText = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const readJson = <T,>(path: string): T => {
  try {
    return JSON.parse(readText(path)) as T;
  } catch {
    return {} as T;
  }
};

const replace = (path: string, text: string): void => {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};

const identity = (from: Partial<Identity>): Identity | null =>
  from.orgId && from.agentId && from.apiKey && from.channelId
    ? { orgId: from.orgId, agentId: from.agentId, apiKey: from.apiKey, channelId: from.channelId }
    : null;

const mirrored = (): Identity | null => {
  const [orgId, agentId, apiKey, channelId] = readText(MIRROR).split(/\r?\n/);
  return identity({ orgId, agentId, apiKey, channelId });
};

const plain = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const merge = (base: unknown, patch: unknown): unknown => {
  if (!plain(base) || !plain(patch)) return patch;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = merge(base[key], value);
  return out;
};

const endpoint = process.env.CLAWBITS_ENDPOINT ?? "https://app.clawbits.ai";
const sandbox = process.env.REEF_PORT_MCP_SANDBOX;
const { CLAWBITS_ORG_ID: org, CLAWBITS_SIGNUP_TOKEN: token } = process.env;

const api = async <T,>(path: string, key?: string, body?: Json): Promise<T> => {
  const res = await fetch(`${endpoint}/api/agentic/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
  return (await res.json()) as T;
};

const known = async (id: Identity): Promise<boolean> => {
  let status: number;
  try {
    const res = await fetch(`${endpoint}/api/agentic/agents/${encodeURIComponent(id.agentId)}/info`, {
      headers: { Authorization: `Bearer ${id.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
  } catch {
    return true;
  }
  if (status !== 401 && status !== 403) return true;
  process.stderr.write("clawbits: this key is no longer known; signing up again\n");
  rmSync(MIRROR, { force: true });
  return false;
};

const enrol = async (orgId: string, session_token: string): Promise<Identity> => {
  const made = await api<Enrolled>("signup-commit", undefined, { session_token });
  const id = identity({ orgId, agentId: made.agent_id, apiKey: made.api_key, channelId: made.channel_id });
  if (!id) throw new Error("signup-commit returned no channel_id");
  return id;
};

const greet = async ({ orgId, agentId, apiKey, channelId }: Identity): Promise<void> => {
  const info = await api<AgentInfo>(`agents/${encodeURIComponent(agentId)}/info`, apiKey).catch((): AgentInfo => ({}));
  const name = info.operator_display_name?.trim();
  const message = name
    ? `Hi ${name}! Agent ${agentId} reporting in for ${orgId}.`
    : `Greetings from ${agentId} to organization ${orgId}!`;
  await api(`mm/channels/${encodeURIComponent(channelId)}/posts`, apiKey, { message });
};

const failed = (step: string) => (err: unknown): null => {
  process.stderr.write(`clawbits: ${step} failed: ${err}\n`);
  return null;
};

const text = readText(CONFIG);
const config: Config = text ? JSON.parse(text) : {};
const kept = identity(config.channels?.clawbits?.accounts?.[ACCOUNT] ?? {}) ?? mirrored();
const id =
  kept && (await known(kept)) ? kept : org && token ? await enrol(org, token).catch(failed("signup")) : null;
if (id) replace(MIRROR, [id.orgId, id.agentId, id.apiKey, id.channelId].join("\n"));

const orgId = id?.orgId ?? org;
const clawbits = {
  endpoint,
  ...(orgId ? { orgId } : {}),
  accounts: { [ACCOUNT]: { endpoint, ...id } },
};
const patch = merge(merge(readJson<Json>(DEFAULTS), readJson<Json>(OVERRIDE)), {
  channels: { clawbits },
  ...(sandbox ? { mcp: { apps: { sandboxOrigin: `http://${process.env.REEF_AGENT}.localhost:${sandbox}` } } } : {}),
});
replace(CONFIG, `${JSON.stringify(merge(config, patch), null, 2)}\n`);

if (id && id !== kept) await greet(id).catch(failed("greeting"));

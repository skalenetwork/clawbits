import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

type Identity = { orgId: string; agentId: string; apiKey: string; channelId: string };
type Json = Record<string, unknown>;
type Config = { channels?: { clawbits?: { accounts?: Record<string, Partial<Identity>> } } };
type SignupEvent = { org_id?: string; agent_id?: string; api_key?: string; channel_id?: string };

const CONFIG = process.env.OPENCLAW_CONFIG_PATH ?? "/home/node/.openclaw/openclaw.json";
const MIRROR = "/home/node/.openclaw/state/clawbits-identity";
const DEFAULTS = "/usr/local/share/clawbits-defaults.json";
const OVERRIDE = "/etc/openclaw/defaults.json";
const ACCOUNT = "default";

const readText = (src: string | number): string => {
  try {
    return readFileSync(src, "utf8");
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

const identity = (from: Partial<Identity>): Identity | null =>
  from.orgId && from.agentId && from.apiKey && from.channelId
    ? { orgId: from.orgId, agentId: from.agentId, apiKey: from.apiKey, channelId: from.channelId }
    : null;

const configured = (): Identity | null =>
  identity(readJson<Config>(CONFIG).channels?.clawbits?.accounts?.[ACCOUNT] ?? {});

const mirrored = (): Identity | null => {
  const [orgId, agentId, apiKey, channelId] = readText(MIRROR).split(/\r?\n/);
  return identity({ orgId, agentId, apiKey, channelId });
};

const signed = (): Identity | null => {
  for (const line of readText(0).split("\n")) {
    let event: SignupEvent;
    try {
      event = JSON.parse(line) as SignupEvent;
    } catch {
      continue;
    }
    const found = identity({
      orgId: event.org_id ?? process.env.CLAWBITS_ORG_ID,
      agentId: event.agent_id,
      apiKey: event.api_key,
      channelId: event.channel_id,
    });
    if (found) return found;
  }
  return null;
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

/** Whether clawbits still knows this identity. A key it has forgotten is a
 * ghost: the agent would boot, restore it every time, and never enrol again.
 * Only an outright rejection counts — a timeout or an outage must not cost an
 * agent its identity. */
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

const [command, source] = process.argv.slice(2);

if (command === "probe") {
  const id = configured() ?? mirrored();
  process.exit(id && (await known(id)) ? 0 : 1);
}

const id = (source === "--stdin" ? signed() : null) ?? configured() ?? mirrored();
if (id) {
  writeFileSync(`${MIRROR}.tmp`, [id.orgId, id.agentId, id.apiKey, id.channelId].join("\n"), {
    mode: 0o600,
  });
  renameSync(`${MIRROR}.tmp`, MIRROR);
} else if (process.env.CLAWBITS_SIGNUP_TOKEN) {
  process.stderr.write("clawbits: signup returned no channel; starting without one\n");
}

const orgId = id?.orgId ?? process.env.CLAWBITS_ORG_ID;
const clawbits = {
  endpoint,
  ...(orgId ? { orgId } : {}),
  accounts: { [ACCOUNT]: { endpoint, ...id } },
};

process.stdout.write(
  JSON.stringify(
    merge(merge(readJson<Json>(DEFAULTS), readJson<Json>(OVERRIDE)), { channels: { clawbits } }),
  ),
);

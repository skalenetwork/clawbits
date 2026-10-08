import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export const CLAWBITS_SERVICE_HANDOFF_CAPABILITY = "service-handoff";
export const CLAWBITS_SLIM_CHANNEL_MIN_VERSION = "0.17.0";

export type ClawBitsServiceOwner = "channel" | "tools";

/** The server's sync nudges, which only the channel's agent WebSocket receives. */
type CompanionNudge = "skills.sync" | "automation.sync";
type CompanionWaker = (nudge: CompanionNudge, accountId: string) => void;

export interface ClawBitsServiceHandoff {
  channelVersion: string;
  servicesMovedTo: "clawbits-tools";
  modelSelection?: true;
  /** Absent on older channels, where the companion's own polls are the only path. */
  onCompanionWake?: (waker: CompanionWaker) => () => void;
}

interface RuntimeContextRegistry {
  register(params: {
    channelId: string;
    capability: string;
    context: ClawBitsServiceHandoff;
  }): { dispose(): void };
  get<T>(params: {
    channelId: string;
    capability: string;
  }): T | undefined;
}

interface RuntimeWithContexts {
  channel?: { runtimeContexts?: RuntimeContextRegistry };
}

function compareVersions(a: string, b: string): number {
  const leftParts = a.split(".");
  const rightParts = b.split(".");
  if (
    leftParts.some((part) => !/^\d+$/u.test(part)) ||
    rightParts.some((part) => !/^\d+$/u.test(part))
  ) {
    return Number.NaN;
  }
  const left = leftParts.map(Number);
  const right = rightParts.map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (!Number.isFinite(l) || !Number.isFinite(r)) return Number.NaN;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export function resolveClawBitsServiceOwner(
  cfg: OpenClawConfig,
): { owner: ClawBitsServiceOwner; valid: boolean; configured: boolean } {
  const channels = cfg.channels;
  const section =
    channels && typeof channels === "object"
      ? (channels as Record<string, unknown>)["clawbits"]
      : undefined;
  const raw =
    section && typeof section === "object"
      ? (section as Record<string, unknown>)["serviceOwner"]
      : undefined;
  if (raw === undefined || raw === null || raw === "") {
    return { owner: "channel", valid: true, configured: false };
  }
  if (raw === "channel" || raw === "tools") {
    return { owner: raw, valid: true, configured: true };
  }
  return { owner: "channel", valid: false, configured: true };
}

// Each plugin bundles its own copy of this module, so the set lives in the
// channel's copy and the tools plugin reaches it only through the handoff.
const companionWakers = new Set<CompanionWaker>();

function onCompanionWake(waker: CompanionWaker): () => void {
  companionWakers.add(waker);
  return () => companionWakers.delete(waker);
}

export function wakeCompanion(nudge: CompanionNudge, accountId: string): void {
  for (const waker of companionWakers) waker(nudge, accountId);
}

export function registerSlimChannelHandoff(
  runtime: RuntimeWithContexts | undefined,
  channelVersion: string,
): { dispose(): void } | undefined {
  return runtime?.channel?.runtimeContexts?.register({
    channelId: "clawbits",
    capability: CLAWBITS_SERVICE_HANDOFF_CAPABILITY,
    context: { channelVersion, servicesMovedTo: "clawbits-tools", modelSelection: true, onCompanionWake },
  });
}

export function readSlimChannelHandoff(
  runtime: RuntimeWithContexts | undefined,
): ClawBitsServiceHandoff | undefined {
  return runtime?.channel?.runtimeContexts?.get<ClawBitsServiceHandoff>({
    channelId: "clawbits",
    capability: CLAWBITS_SERVICE_HANDOFF_CAPABILITY,
  });
}

export function supportsCompanionServices(
  handoff: ClawBitsServiceHandoff | undefined,
): boolean {
  if (!handoff || handoff.servicesMovedTo !== "clawbits-tools") return false;
  const comparison = compareVersions(
    handoff.channelVersion,
    CLAWBITS_SLIM_CHANNEL_MIN_VERSION,
  );
  return Number.isFinite(comparison) && comparison >= 0;
}

export function supportsModelSelection(handoff: ClawBitsServiceHandoff | undefined): boolean {
  return handoff?.modelSelection === true;
}

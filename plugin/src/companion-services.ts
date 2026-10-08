import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { listClawBitsAccountIds, resolveClawBitsAccount } from "./accounts.js";
import { setCronHandle, type CronHandle } from "./automations/cron-handle.js";
import { runAutomationsReconciler, wakeAutomationsReconciler } from "./automations/reconcile.js";
import { ChannelWatermarkStore } from "./channel-watermarks.js";
import { resolveKnownAnswers } from "./challenge.js";
import { buildClientForAccount } from "./client-factory.js";
import { dispatchInboundEmail } from "./email-adapter.js";
import { runEmailPoller } from "./email-poller.js";
import { logInfo, logWarn } from "./file-logger.js";
import { runModelsReporter } from "./models/sync.js";
import {
  readSlimChannelHandoff,
  resolveClawBitsServiceOwner,
  supportsCompanionServices,
  supportsModelSelection,
} from "./service-handoff.js";
import { runSkillsReporter, wakeSkillsReporter } from "./skills/sync.js";
import { registerUsageHooks } from "./usage/collector.js";
import { runUsageReporter } from "./usage/reporter.js";

interface GatewayHookContext {
  config?: OpenClawConfig;
  workspaceDir?: string;
  getCron?: () => CronHandle | undefined;
}

export interface CompanionServiceActivation {
  active: boolean;
  reason: "active" | "channel-owner" | "invalid-owner" | "missing-slim-channel";
}

export function resolveCompanionServiceActivation(
  cfg: OpenClawConfig,
  runtime: unknown,
): CompanionServiceActivation {
  const owner = resolveClawBitsServiceOwner(cfg);
  if (!owner.valid) return { active: false, reason: "invalid-owner" };
  if (owner.owner !== "tools") return { active: false, reason: "channel-owner" };
  if (!supportsCompanionServices(readSlimChannelHandoff(runtime as never))) {
    return { active: false, reason: "missing-slim-channel" };
  }
  return { active: true, reason: "active" };
}

interface RunningServices {
  controller: AbortController;
  tasks: Promise<void>[];
  emailWatermarks: ChannelWatermarkStore;
  usageActive: boolean;
  stopWakes?: () => void;
}

let running: RunningServices | undefined;

async function stopRunningServices(): Promise<void> {
  const current = running;
  running = undefined;
  if (!current) return;
  current.stopWakes?.();
  current.controller.abort(new Error("Clawbits companion services stopped"));
  await Promise.allSettled(current.tasks);
  await current.emailWatermarks.flush();
  setCronHandle(undefined);
}

function startTask(tasks: Promise<void>[], task: Promise<void>): void {
  tasks.push(task.catch(() => undefined));
}

async function startCompanionServices(
  api: OpenClawPluginApi,
  cfg: OpenClawConfig,
  ctx: GatewayHookContext,
): Promise<void> {
  await stopRunningServices();
  const activation = resolveCompanionServiceActivation(cfg, api.runtime);
  if (!activation.active) {
    const message =
      activation.reason === "invalid-owner"
        ? "invalid channels.clawbits.serviceOwner; expected 'channel' or 'tools'"
        : activation.reason === "missing-slim-channel"
          ? "serviceOwner=tools but no compatible slim Clawbits channel is active; companion services remain idle"
          : "serviceOwner is channel; companion services remain idle";
    if (activation.reason === "channel-owner") logInfo(api.logger, `[clawbits-tools] ${message}`);
    else logWarn(api.logger, `[clawbits-tools] ${message}`);
    return;
  }

  setCronHandle(ctx.getCron?.());
  const controller = new AbortController();
  const tasks: Promise<void>[] = [];
  const emailWatermarks = ChannelWatermarkStore.emailFileBacked();
  const state: RunningServices = {
    controller,
    tasks,
    emailWatermarks,
    usageActive: false,
  };
  running = state;
  const handoff = readSlimChannelHandoff(api.runtime);
  const modelSelection = supportsModelSelection(handoff);
  state.stopWakes = handoff?.onCompanionWake?.((nudge, accountId) => {
    if (nudge === "skills.sync") wakeSkillsReporter();
    else wakeAutomationsReconciler(accountId);
  });
  let skillsStarted = false;

  for (const accountId of listClawBitsAccountIds(cfg)) {
    const account = resolveClawBitsAccount({ cfg, accountId });
    if (!account.enabled || !account.configured || !account.apiKey || !account.agentId) {
      logInfo(
        api.logger,
        `[clawbits-tools/${accountId}] services idle: account disabled or not configured`,
      );
      continue;
    }
    const client = buildClientForAccount(account);
    const answers = resolveKnownAnswers(account.knownAnswers);
    state.usageActive = true;

    startTask(
      tasks,
      runAutomationsReconciler({
        client,
        abortSignal: controller.signal,
        accountId,
        ownerChannelId: account.channelId,
        log: api.logger,
      }),
    );
    startTask(
      tasks,
      runUsageReporter({
        client,
        abortSignal: controller.signal,
        accountId,
        log: api.logger,
      }),
    );

    if (modelSelection) {
      startTask(
        tasks,
        runModelsReporter({
          client,
          accountId,
          runtime: api.runtime,
          abortSignal: controller.signal,
          log: api.logger,
        }),
      );
    }

    // One reporter per gateway: the skill roots are shared across accounts.
    if (!skillsStarted) {
      skillsStarted = true;
      startTask(
        tasks,
        runSkillsReporter({
          client,
          abortSignal: controller.signal,
          accountId,
          workspaceDir: ctx.workspaceDir,
          runtimeVersion: api.runtime.version,
          log: api.logger,
        }),
      );
    }

    if (account.emailEnabled) {
      startTask(
        tasks,
        runEmailPoller({
          client,
          account,
          abortSignal: controller.signal,
          log: api.logger,
          watermarkStore: emailWatermarks,
          onEmailMessage: (message) =>
            dispatchInboundEmail(
              {
                cfg,
                accountId,
                account,
                channelRuntime: api.runtime.channel,
                log: api.logger,
              },
              message,
              { client, answers },
            ),
        }),
      );
    }
  }

  logInfo(api.logger, "[clawbits-tools] companion services started");
}

export function registerCompanionServices(api: OpenClawPluginApi): void {
  // Host hooks must be registered during plugin setup, but remain inert beside
  // a legacy channel owner so no duplicate usage queue is accumulated.
  registerUsageHooks({
    on: (hook, handler) => {
      api.on?.(hook, (event: unknown, ctx?: unknown) => {
        if (running?.usageActive) handler(event, ctx);
      });
    },
  });
  api.on?.("gateway_start", async (_event, hookContext) => {
    // The host's public context types `getCron` as the narrow
    // PluginHookGatewayCronService; the object it actually hands over is the
    // full runtime CronService. See automations/cron-handle.ts for why we use
    // the wider surface (re-verified against 2026.9.2, which still has `run`).
    const ctx = (hookContext ?? {}) as unknown as GatewayHookContext;
    await startCompanionServices(api, ctx.config ?? api.config, ctx);
  });
  api.on?.("cron_changed", () => {
    if (running) wakeAutomationsReconciler();
  });
  api.on?.("gateway_stop", async () => {
    await stopRunningServices();
  });
}

export async function stopCompanionServicesForTests(): Promise<void> {
  await stopRunningServices();
}

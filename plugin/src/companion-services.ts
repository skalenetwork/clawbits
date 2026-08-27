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
import {
  readSlimChannelHandoff,
  resolveClawBitsServiceOwner,
  supportsCompanionServices,
} from "./service-handoff.js";
import { getWorkspaceDir, setWorkspaceDir } from "./skills/scan.js";
import {
  claimSkillsReporter,
  releaseSkillsReporter,
  runSkillsReporter,
} from "./skills/sync.js";
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
  skillsOwner?: string;
}

let running: RunningServices | undefined;

async function stopRunningServices(): Promise<void> {
  const current = running;
  running = undefined;
  if (!current) return;
  current.controller.abort(new Error("Clawbits companion services stopped"));
  await Promise.allSettled(current.tasks);
  if (current.skillsOwner) releaseSkillsReporter(current.skillsOwner);
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
  setWorkspaceDir(ctx.workspaceDir);
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

    if (!state.skillsOwner && claimSkillsReporter(accountId)) {
      state.skillsOwner = accountId;
      startTask(
        tasks,
        runSkillsReporter({
          client,
          abortSignal: controller.signal,
          accountId,
          workspaceDir: getWorkspaceDir(),
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
  api.on?.("gateway_start", async (_event: unknown, hookContext?: GatewayHookContext) => {
    const cfg = hookContext?.config ?? api.config;
    await startCompanionServices(api, cfg, hookContext ?? {});
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

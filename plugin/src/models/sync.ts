import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CHANNEL_ID } from "../accounts.js";
import { type ClawBitsClient, timedRequest } from "../client.js";
import { type BasicLogger, logInfo, logWarn } from "../file-logger.js";
import { readCatalog } from "./catalog.js";

const STATE_PATH = "/api/agentic/models/state";
const REQUEST_TIMEOUT_MS = 20_000;
const MODELS_REPORT_INTERVAL_MS = 600_000;

interface ModelsReporterOptions {
  client: ClawBitsClient;
  accountId: string;
  runtime: OpenClawPluginApi["runtime"];
  abortSignal: AbortSignal;
  log?: BasicLogger;
}

export async function runModelsReporter(opts: ModelsReporterOptions): Promise<void> {
  const { client, accountId, runtime, abortSignal, log } = opts;
  const { channel, config } = runtime;
  if (
    typeof channel?.routing?.resolveAgentRoute !== "function" ||
    typeof config?.current !== "function"
  ) {
    return;
  }
  let lastSent: string | undefined;
  while (!abortSignal.aborted) {
    try {
      const { agentId } = channel.routing.resolveAgentRoute({
        cfg: config.current() as OpenClawConfig,
        channel: CHANNEL_ID,
        accountId,
      });
      const report = await readCatalog(runtime, agentId);
      const payload = JSON.stringify(report);
      if (report && payload !== lastSent) {
        await timedRequest<unknown>(client, "models report", "POST", STATE_PATH, {
          json: report,
          timeoutMs: REQUEST_TIMEOUT_MS,
          parent: abortSignal,
        });
        lastSent = payload;
        logInfo(log, `[clawbits-tools/${accountId}] models: reported ${String(report.models.length)} for ${agentId}`);
      }
    } catch (err) {
      logWarn(log, `[clawbits-tools/${accountId}] models report failed: ${String((err as Error)?.message ?? err)}`);
    }
    await sleep(MODELS_REPORT_INTERVAL_MS, undefined, { signal: abortSignal }).catch(() => undefined);
  }
}

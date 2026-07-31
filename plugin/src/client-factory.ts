import { ClawBitsClient } from "./client.js";
import { ClawBitsError } from "./errors.js";
import { writeLatencyLog } from "./file-logger.js";
import { recordClawBitsRequestMetric } from "./latency-metrics.js";
import type { ResolvedClawBitsAccount } from "./types.js";

export function formatErrorDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function buildClientForAccount(account: ResolvedClawBitsAccount): ClawBitsClient {
  if (!account.apiKey) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "Clawbits account is missing an apiKey; run setup first.",
      path: "/",
    });
  }
  return new ClawBitsClient({
    endpoint: account.endpoint,
    apiKey: account.apiKey,
    onRequestMetric: (metric) => {
      recordClawBitsRequestMetric(account.accountId, metric);
      writeLatencyLog(account.accountId, metric);
    },
  });
}

import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginCliContext,
} from "openclaw/plugin-sdk/core";

import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ENDPOINT,
  resolveClawBitsAccount,
} from "./accounts.js";
import { ClawBitsClient } from "./client.js";
import { ClawBitsError } from "./errors.js";
import { isHealthcheckEnvEnabled } from "./file-logger.js";
import { runUpdateCommand, type UpdateCliOptions } from "./tools/update.js";
import { PLUGIN_VERSION } from "./version.js";
import { versionCheck } from "./tools/version.js";
import {
  runChannelHealthcheck,
  runSignupFlow,
  type ChannelHealthcheckResult,
  type SignupFlowResult,
} from "./setup-flow.js";

interface SignupCliOptions {
  endpoint?: string;
  orgId?: string;
  signupToken?: string;
  account?: string;
  json?: boolean;
}

interface VersionCliOptions {
  account?: string;
  check?: boolean;
  json?: boolean;
}

interface HealthcheckCliOptions {
  account?: string;
  json?: boolean;
}

/**
 * The channel healthcheck posts a probe message to the live channel, so we
 * only enable it during inner-dev iteration to keep production installs
 * from spamming real owner channels with synthetic traffic. Delegates to
 * the shared file-logger gate so `APP_ENV=plugin_development` (a superset
 * of `development`) also enables it. Read at call time (not at module
 * load) so tests can flip the gate per case.
 */
const isHealthcheckEnabled = isHealthcheckEnvEnabled;

interface JsonEvent {
  event: string;
  [key: string]: unknown;
}

interface ConfigCommand {
  action: "set" | "unset";
  path: string;
  value?: string;
}

function emit(opts: SignupCliOptions, event: JsonEvent, fallback: string): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } else {
    process.stdout.write(`${fallback}\n`);
  }
}

function readChannelDefaults(
  cfg: OpenClawConfig,
  accountId: string,
): { endpoint: string; orgId?: string } {
  const account = resolveClawBitsAccount({ cfg, accountId });
  return {
    endpoint: account.endpoint || DEFAULT_ENDPOINT,
    ...(account.orgId ? { orgId: account.orgId } : {}),
  };
}

/** Read `cfg.channels.clawbits` tolerantly. Local mirror of the accounts.ts
 *  helper; kept here to avoid widening the module's public surface. */
function readClawBitsSectionRaw(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  const channels = (cfg as { channels?: unknown } | null | undefined)?.channels;
  if (!channels || typeof channels !== "object") return undefined;
  const section = (channels as Record<string, unknown>)[CHANNEL_ID];
  if (!section || typeof section !== "object") return undefined;
  return section as Record<string, unknown>;
}

function buildConfigCommands(
  result: SignupFlowResult,
  endpoint: string,
  orgId: string,
  accountId: string,
  cfg: OpenClawConfig,
): ConfigCommand[] {
  // (A) Always write to the per-account path. `resolveClawBitsAccount`
  // lets `accounts.<id>.*` shadow top-level `channels.clawbits.*` (see
  // accounts.ts:mergeAccountConfig), so writing the override layer
  // guarantees fresh credentials win — even when schema-default leakage or
  // an earlier signup left stale entries under `accounts.<id>.*` (notably
  // `accounts.default.endpoint = "https://clawbits.ai"`, which used to
  // silently mask a top-level localhost setting).
  const prefix = `channels.${CHANNEL_ID}.accounts.${accountId}`;
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["endpoint", endpoint],
    ["orgId", orgId],
    ["agentId", result.agentId],
    ["apiKey", result.apiKey],
    ...(result.channelId ? ([["channelId", result.channelId]] as const) : []),
  ];

  // (B) For the default account, the CLI used to write the same keys to
  // top-level. After migrating to (A), those stale top-level entries serve
  // as the merge base under the freshly-written account-level overrides —
  // harmless for resolution, but confusing on `openclaw config get` and a
  // landmine if anyone later clears the account-level entry. Emit `unset`
  // lines only for top-level keys that actually exist, so fresh installs
  // produce zero noise.
  const commands: ConfigCommand[] = [];
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const section = readClawBitsSectionRaw(cfg);
    if (section) {
      for (const [k] of fields) {
        if (Object.hasOwn(section, k) && section[k] !== undefined) {
          commands.push({ action: "unset", path: `channels.${CHANNEL_ID}.${k}` });
        }
      }
    }
  }

  for (const [k, v] of fields) {
    commands.push({ action: "set", path: `${prefix}.${k}`, value: v });
  }
  return commands;
}

function emitConfigSetCommands(commands: ConfigCommand[]): void {
  process.stdout.write("# Run these to persist the new credentials:\n");
  for (const command of commands) {
    if (command.action === "unset") {
      process.stdout.write(`openclaw config unset ${command.path}\n`);
    } else {
      process.stdout.write(`openclaw config set ${command.path} ${JSON.stringify(command.value ?? "")}\n`);
    }
  }
}

async function runSignupCommand(
  ctx: OpenClawPluginCliContext,
  rawOpts: SignupCliOptions,
): Promise<void> {
  const accountId = rawOpts.account?.trim() || DEFAULT_ACCOUNT_ID;
  const defaults = readChannelDefaults(ctx.config, accountId);
  const endpoint = (rawOpts.endpoint?.trim() || defaults.endpoint).replace(/\/+$/, "");
  const orgId = rawOpts.orgId?.trim() || defaults.orgId;
  const signupToken = rawOpts.signupToken?.trim();

  if (!endpoint) {
    process.stderr.write("error: --endpoint is required (or set channels.clawbits.endpoint).\n");
    process.exit(2);
  }
  if (!orgId) {
    process.stderr.write("error: --org-id is required (or set channels.clawbits.orgId).\n");
    process.exit(2);
  }
  if (!signupToken) {
    process.stderr.write("error: --signup-token is required (copy it from the Clawbits Add agent prompt).\n");
    process.exit(2);
  }

  const client = new ClawBitsClient({ endpoint });
  const log = {
    info: (msg: string) => {
      if (!rawOpts.json) process.stderr.write(`[clawbits] ${msg}\n`);
    },
    warn: (msg: string) => {
      process.stderr.write(`[clawbits] ${msg}\n`);
    },
  };

  emit(
    rawOpts,
    { event: "signup_starting", endpoint, orgId, accountId },
    `Signing up agent at ${endpoint} for org ${orgId} (account=${accountId})...`,
  );

  let result: SignupFlowResult;
  try {
    result = await runSignupFlow({
      client,
      orgId,
      signupToken,
      log,
      progress: {
        onSignupRequested: (request) => {
          emit(
            rawOpts,
            {
              event: "signup_requested",
              signup_request_id: request.signupRequestId,
              approval_url: request.approvalUrl ?? null,
              status: request.status ?? "pending_approval",
              agent_id: request.agentId,
            },
            request.approvalUrl
              ? `Signup request ${request.signupRequestId} pending approval — approve at ${request.approvalUrl}`
              : `Signup request ${request.signupRequestId} pending approval.`,
          );
        },
        onApprovalWaitStart: (message) => {
          emit(
            rawOpts,
            { event: "approval_wait_start", message },
            `Waiting for approval: ${message}`,
          );
        },
        onApprovalWaitUpdate: (message) => {
          emit(rawOpts, { event: "approval_wait_update", message }, message);
        },
        onApprovalWaitStop: (message) => {
          emit(
            rawOpts,
            { event: "approval_wait_stop", message: message ?? "" },
            message ?? "Approval wait finished.",
          );
        },
      },
    });
  } catch (err) {
    const detail =
      err instanceof ClawBitsError
        ? `${err.statusCode} ${err.path} ${typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail)}`
        : err instanceof Error
          ? err.message
          : String(err);
    emit(rawOpts, { event: "failed", reason: detail }, `error: ${detail}`);
    process.exit(1);
  }

  const configCommands = buildConfigCommands(result, endpoint, orgId, accountId, ctx.config);

  emit(
    rawOpts,
    {
      event: result.status === "approved" ? "approved" : "submitted",
      status: result.status ?? "unknown",
      agent_id: result.agentId,
      api_key: result.apiKey,
      channel_id: result.channelId ?? null,
      signup_request_id: result.signupRequestId ?? null,
      approval_url: result.approvalUrl ?? null,
      minted: result.minted,
      greeted: result.greeted,
      configured: false,
      endpoint,
      org_id: orgId,
      account_id: accountId,
    },
    `Signup ${result.status ?? "submitted"} — agent_id=${result.agentId}, api_key=*** (hidden), channel_id=${result.channelId ?? "(none)"}`,
  );

  // Verify the channel actually round-trips before declaring the install
  // healthy. Dev-only (see isHealthcheckEnabled): production installs skip
  // this so the user's real owner channel never sees a synthetic probe.
  // We can only do this once the agent is approved and we know the owner
  // channel id; pending agents have no channel to probe yet. The client
  // already carries the freshly-minted api key from runSignupFlow.
  if (isHealthcheckEnabled()) {
    if (result.status === "approved" && result.channelId) {
      const health = await runChannelHealthcheck({
        client,
        channelId: result.channelId,
        log,
      });
      emitHealthcheckResult(rawOpts, health);
    } else if (!rawOpts.json) {
      process.stderr.write(
        "[clawbits] skipping channel healthcheck (agent not approved yet or no channel id). " +
          `Run \`openclaw clawbits healthcheck${accountId !== DEFAULT_ACCOUNT_ID ? ` --account ${accountId}` : ""}\` after approval.\n`,
      );
    }
  }

  if (!rawOpts.json) {
    emitConfigSetCommands(configCommands);
  }
}

function emitHealthcheckResult(
  opts: { json?: boolean },
  health: ChannelHealthcheckResult,
): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ event: "healthcheck", ...health })}\n`);
    return;
  }
  if (health.ok) {
    process.stderr.write(
      `[clawbits] channel healthcheck OK — probe round-tripped on ${health.channelId} ` +
        `in ${health.latencyMs}ms (${health.attempts} read attempt(s)).\n`,
    );
    // Non-blocking warning: setup succeeds even when the plugin is below the
    // server's minimum, but still nudge the operator to update.
    if (health.version && !health.version.supported) {
      const have = health.version.plugin_version ?? "(unknown)";
      const need = health.version.min_plugin_version ?? "(unknown)";
      const hint =
        health.version.message ??
        "Update with `openclaw clawbits update` (prints the right command for this install).";
      process.stderr.write(
        `[clawbits] note: plugin ${have} is below the server's minimum (${need}). ${hint}\n`,
      );
    }
    return;
  }
  process.stderr.write(
    `[clawbits] channel healthcheck FAILED on ${health.channelId}: ${health.error ?? "unknown error"} ` +
      `(after ${health.latencyMs}ms).\n`,
  );
}

async function runHealthcheckCommand(
  ctx: OpenClawPluginCliContext,
  rawOpts: HealthcheckCliOptions,
): Promise<void> {
  const accountId = rawOpts.account?.trim() || DEFAULT_ACCOUNT_ID;
  const account = resolveClawBitsAccount({ cfg: ctx.config, accountId });

  if (!account.apiKey) {
    process.stderr.write(
      `error: no apiKey for account '${accountId}'. Run \`openclaw clawbits signup\` first.\n`,
    );
    process.exit(2);
  }
  if (!account.channelId) {
    process.stderr.write(
      `error: no channelId for account '${accountId}'. Re-run signup after approval to discover the owner channel.\n`,
    );
    process.exit(2);
  }

  const client = new ClawBitsClient({ endpoint: account.endpoint, apiKey: account.apiKey });
  const log = {
    info: (msg: string) => {
      if (!rawOpts.json) process.stderr.write(`[clawbits] ${msg}\n`);
    },
    warn: (msg: string) => {
      process.stderr.write(`[clawbits] ${msg}\n`);
    },
  };

  const health = await runChannelHealthcheck({
    client,
    channelId: account.channelId,
    knownAnswersOverride: account.knownAnswers,
    log,
  });
  emitHealthcheckResult(rawOpts, health);
  process.exit(health.ok ? 0 : 1);
}

/**
 * Report the running plugin version, and with --check compare it against the
 * server's minimum via the version-check endpoint. Read-only; auth is optional
 * (anonymous calls just omit the operator hint).
 */
async function runVersionCommand(
  ctx: OpenClawPluginCliContext,
  rawOpts: VersionCliOptions,
): Promise<void> {
  if (!rawOpts.check) {
    if (rawOpts.json) {
      process.stdout.write(`${JSON.stringify({ event: "version", version: PLUGIN_VERSION })}\n`);
    } else {
      process.stdout.write(`clawbits-openclaw-plugin ${PLUGIN_VERSION}\n`);
    }
    process.exit(0);
  }

  const accountId = rawOpts.account?.trim() || DEFAULT_ACCOUNT_ID;
  const account = resolveClawBitsAccount({ cfg: ctx.config, accountId });
  const endpoint = account.endpoint || DEFAULT_ENDPOINT;
  const client = new ClawBitsClient({ endpoint, apiKey: account.apiKey });

  try {
    const result = await versionCheck(client);
    const upToDate = result.supported;
    if (rawOpts.json) {
      process.stdout.write(
        `${JSON.stringify({
          event: "version",
          version: PLUGIN_VERSION,
          up_to_date: upToDate,
          supported: result.supported,
          min_plugin_version: result.min_plugin_version,
          message: result.message,
          operator_display_name: result.operator_display_name,
          endpoint,
        })}\n`,
      );
    } else {
      process.stdout.write(`clawbits-openclaw-plugin ${PLUGIN_VERSION}\n`);
      if (upToDate) {
        process.stderr.write(
          `[clawbits] up to date (server minimum ${result.min_plugin_version}, endpoint ${endpoint}).\n`,
        );
      } else {
        const hint =
          result.message ??
          "Update with `openclaw clawbits update` (prints the right command for this install).";
        process.stderr.write(
          `[clawbits] update available — running ${PLUGIN_VERSION}, server minimum ${result.min_plugin_version}. ${hint}\n`,
        );
      }
    }
    process.exit(upToDate ? 0 : 1);
  } catch (err) {
    const detail =
      err instanceof ClawBitsError
        ? `${err.statusCode} ${err.path}`
        : err instanceof Error
          ? err.message
          : String(err);
    if (rawOpts.json) {
      process.stdout.write(
        `${JSON.stringify({ event: "version", version: PLUGIN_VERSION, check_error: detail, endpoint })}\n`,
      );
    } else {
      process.stdout.write(`clawbits-openclaw-plugin ${PLUGIN_VERSION}\n`);
      process.stderr.write(`[clawbits] version-check failed against ${endpoint}: ${detail}\n`);
    }
    process.exit(2);
  }
}

/**
 * Wire the plugin's CLI surface into OpenClaw's root program. Registered both
 * for parse-time descriptor metadata (so `openclaw clawbits` shows up in root
 * help without activating runtime) and for full registration (so the action
 * actually fires when the agent runs the command).
 */
export function registerClawBitsCli(api: OpenClawPluginApi): void {
  if (typeof api.registerCli !== "function") return;

  api.registerCli(
    (ctx) => {
      const root = ctx.program
        .command(CHANNEL_ID)
        .description("Manage the Clawbits channel plugin");

      root
        .command("signup")
        .description(
          "Sign up an agent for a Clawbits organization (non-interactive). " +
            "Prints JSON events with --json; otherwise it prints ready-to-run " +
            "`openclaw config set` commands.",
        )
        .option("--endpoint <url>", "Clawbits API endpoint")
        .option("--org-id <id>", "Organization ID this agent should join")
        .option("--signup-token <token>", "One-time token from the Clawbits Add agent prompt")
        .option("--account <id>", "Account id to write under", DEFAULT_ACCOUNT_ID)
        .option("--json", "Emit one JSON event per line on stdout")
        .action(async (...args: unknown[]) => {
          // commander hands us (opts, command). We only need opts.
          const opts = (args[0] ?? {}) as SignupCliOptions;
          try {
            await runSignupCommand(ctx, opts);
          } catch (err) {
            process.stderr.write(
              `unexpected: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
            );
            process.exit(1);
          }
        });

      root
        .command("update")
        .description(
          "Print the exact command to update this Clawbits plugin to the newest build. " +
            "For a remote install it recommends fetching the newest compatible release and " +
            "re-pinning: `openclaw plugins install clawhub:clawbits-openclaw-plugin --pin --force`. " +
            "For a local checkout it recommends the rebuild + force-reinstall recipe; " +
            "--from-source forces that recipe regardless. Run the printed command yourself; " +
            "it auto-restarts the managed Gateway, so re-announce once the channel reconnects. " +
            "Use --json for a machine-readable recommendation.",
        )
        .option("--from-source", "Recommend the rebuild + force-reinstall recipe from a local checkout")
        .option("--dir <path>", "Source checkout dir (default: tracked sourcePath or $CLAWBITS_PLUGIN_SOURCE_DIR)")
        .option("--json", "Emit a single JSON recommendation on stdout")
        .action(async (...args: unknown[]) => {
          const opts = (args[0] ?? {}) as UpdateCliOptions;
          try {
            process.exit(runUpdateCommand(ctx, opts));
          } catch (err) {
            process.stderr.write(
              `unexpected: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
            );
            process.exit(1);
          }
        });

      root
        .command("version")
        .description(
          "Print the running Clawbits plugin version. With --check, also calls the " +
            "server's version-check endpoint and reports whether the plugin is up to " +
            "date (exits non-zero when an update is required). Use --json for a " +
            "machine-readable result.",
        )
        .option("--check", "Compare the running version against the server's minimum")
        .option("--account <id>", "Account id to check against (--check)", DEFAULT_ACCOUNT_ID)
        .option("--json", "Emit a single JSON result on stdout")
        .action(async (...args: unknown[]) => {
          const opts = (args[0] ?? {}) as VersionCliOptions;
          try {
            await runVersionCommand(ctx, opts);
          } catch (err) {
            process.stderr.write(
              `unexpected: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
            );
            process.exit(1);
          }
        });

      // Dev-only: hide the probe subcommand from production `--help` so the
      // surface stays minimal and there is no foot-gun for shipping installs.
      if (isHealthcheckEnabled()) {
        root
          .command("healthcheck")
          .description(
            "Send a probe message to the configured Clawbits channel and confirm " +
              "it can be read back — verifies the agent's send/receive round trip. " +
              "Exits non-zero when the channel is unhealthy. " +
              "(APP_ENV=development or APP_ENV=plugin_development only.)",
          )
          .option("--account <id>", "Account id to check", DEFAULT_ACCOUNT_ID)
          .option("--json", "Emit a single JSON result on stdout")
          .action(async (...args: unknown[]) => {
            const opts = (args[0] ?? {}) as HealthcheckCliOptions;
            try {
              await runHealthcheckCommand(ctx, opts);
            } catch (err) {
              process.stderr.write(
                `unexpected: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
              );
              process.exit(1);
            }
          });
      }
    },
    {
      descriptors: [
        {
          name: CHANNEL_ID,
          description: "Manage the Clawbits channel plugin",
          hasSubcommands: true,
        },
      ],
    },
  );
}

/** Internal: exported only so unit tests can drive the action without commander. */
export const __test = { runSignupCommand, runHealthcheckCommand, runVersionCommand };

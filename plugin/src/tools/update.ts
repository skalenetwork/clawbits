// Self-update guidance for the Clawbits OpenClaw plugin.
//
// Backs `openclaw clawbits update`. The agent can be told, in plain
// language, to "update your Clawbits plugin"; this prints the exact command
// to run.
//
// Why print instead of execute: OpenClaw's install-time security scan
// rejects plugins that spawn shell/subprocess APIs, so the runtime cannot
// run the upgrade itself. This mirrors the `signup` command, which prints
// ready-to-run `openclaw config set` lines rather than mutating config
// in-process. The agent runs the printed command from its shell.
//
// Provisioning model: agents are installed as a PINNED REMOTE ClawHub
// package. The canonical self-update re-fetches the newest compatible build
// and re-pins to it, so the install stays pinned without any version
// bookkeeping:
//
//     openclaw plugins install clawhub:clawbits-openclaw-plugin --pin --force
//
// (`--force` overwrites in place; the version-less spec resolves to the
// newest compatible release; `--pin` pins to whatever it resolved.)
//
// This command used to carry `--acknowledge-clawhub-risk`. OpenClaw REMOVED
// that flag - the CLI now hard-errors with "does not recognize option", so the
// printed command failed for every agent that ran it. The gate moved into
// `security.installPolicy`; a community package prints a review warning and
// installs. Do not reintroduce the flag; if installs ever fail closed again,
// the fix is that config key.
//
// `--from-source` is a developer escape hatch for a local checkout: rebuild
// `dist/` and force-reinstall from the directory. OpenClaw never compiles
// TypeScript for you (installs run `--ignore-scripts`), hence the explicit
// `npm run build` before `plugins install <dir> --force`.
//
// Either path auto-restarts a managed Gateway, so the agent should treat a
// successful update as a terminal action and re-announce once the channel
// poller reconnects.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { OpenClawConfig, OpenClawPluginCliContext } from "openclaw/plugin-sdk/core";

import { CHANNEL_ID } from "../accounts.js";

const PLUGIN_ID = CHANNEL_ID; // "clawbits"
const PACKAGE_NAME = "clawbits-openclaw-plugin";
const CLAWHUB_SPEC = `clawhub:${PACKAGE_NAME}`;
/** Upgrade a pinned remote install to the newest compatible build, staying
 *  pinned. Version-less spec → newest compatible; --pin re-pins to it;
 *  --force overwrites the current install in place. */
const PINNED_UPDATE_COMMAND = `openclaw plugins install ${CLAWHUB_SPEC} --pin --force`;

export interface UpdateCliOptions {
  /** Developer escape hatch: rebuild + force-reinstall from a local checkout. */
  fromSource?: boolean;
  /** Source checkout dir for --from-source. Defaults to the tracked install
   *  sourcePath or $CLAWBITS_PLUGIN_SOURCE_DIR. */
  dir?: string;
  json?: boolean;
}

interface InstallRecord {
  source?: string;
  sourcePath?: string;
  version?: string;
}

interface UpdateEvent {
  event: string;
  [key: string]: unknown;
}

/** Read the tracked install record for this plugin without shelling out.
 *
 *  Primary source is the SDK-provided merged config (`plugins.installs.<id>`).
 *  Falls back to the legacy on-disk index when the live config does not carry
 *  the record. All reads are best-effort. */
function readInstallRecord(cfg: OpenClawConfig): InstallRecord | null {
  return readRecordFromConfig(cfg) ?? readRecordFromLegacyIndex();
}

function readRecordFromConfig(cfg: OpenClawConfig): InstallRecord | null {
  const plugins = (cfg as { plugins?: unknown } | null | undefined)?.plugins;
  if (!plugins || typeof plugins !== "object") return null;
  const installs = (plugins as { installs?: unknown }).installs;
  if (!installs || typeof installs !== "object") return null;
  const record = (installs as Record<string, unknown>)[PLUGIN_ID];
  if (!record || typeof record !== "object") return null;
  return coerceRecord(record as Record<string, unknown>);
}

function readRecordFromLegacyIndex(): InstallRecord | null {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.OPENCLAW_HOME?.trim() ||
    path.join(homedir(), ".openclaw");
  for (const name of ["installs.json", "installs.json.migrated"]) {
    const file = path.join(stateDir, "plugins", name);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
        installRecords?: Record<string, unknown>;
      };
      const record = parsed.installRecords?.[PLUGIN_ID];
      if (record && typeof record === "object") {
        return coerceRecord(record as Record<string, unknown>);
      }
    } catch {
      // ignore malformed/partial index
    }
  }
  return null;
}

function coerceRecord(raw: Record<string, unknown>): InstallRecord {
  return {
    source: typeof raw.source === "string" ? raw.source : undefined,
    sourcePath: typeof raw.sourcePath === "string" ? raw.sourcePath : undefined,
    version: typeof raw.version === "string" ? raw.version : undefined,
  };
}

function resolveSourceDir(opts: UpdateCliOptions, record: InstallRecord | null): string | undefined {
  const candidate =
    opts.dir?.trim() ||
    process.env.CLAWBITS_PLUGIN_SOURCE_DIR?.trim() ||
    record?.sourcePath;
  return candidate ? path.resolve(candidate) : undefined;
}

const RESTART_NOTE =
  "Updating auto-restarts the managed Gateway, so the channel poller drops and reconnects — " +
  "treat the update as a terminal action and re-announce once it is back.";

function emit(opts: UpdateCliOptions, event: UpdateEvent, human: string[]): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } else {
    for (const line of human) process.stderr.write(`${line}\n`);
  }
}

/** Build the from-source command list for a resolved checkout dir. */
function fromSourceCommands(dir: string): string[] {
  if (existsSync(path.join(dir, "update-from-source.sh"))) {
    return [`bash ${dir}/update-from-source.sh`];
  }
  return [
    `cd ${dir}`,
    "git pull --ff-only   # if this checkout tracks a remote",
    "npm run build",
    `openclaw plugins install ${dir} --force`,
  ];
}

function recommendFromSource(opts: UpdateCliOptions, record: InstallRecord | null): number {
  const dir = resolveSourceDir(opts, record);
  if (!dir) {
    emit(
      opts,
      {
        event: "needs_source_dir",
        hint: "pass --dir <checkout>, or set CLAWBITS_PLUGIN_SOURCE_DIR",
      },
      [
        "[clawbits] --from-source requested, but no checkout dir is known.",
        "[clawbits] Re-run with --dir <path-to-plugin-checkout>, or set CLAWBITS_PLUGIN_SOURCE_DIR.",
      ],
    );
    return 2;
  }
  if (!existsSync(path.join(dir, "openclaw.plugin.json"))) {
    emit(
      opts,
      { event: "invalid_source_dir", dir, hint: "directory has no openclaw.plugin.json at its root" },
      [
        `[clawbits] ${dir} is not a plugin checkout (no openclaw.plugin.json at its root).`,
        "[clawbits] Point --dir at the directory that contains openclaw.plugin.json.",
      ],
    );
    return 2;
  }
  const commands = fromSourceCommands(dir);
  emit(
    opts,
    {
      event: "recommendation",
      mode: "from-source",
      source_dir: dir,
      installed_version: record?.version ?? null,
      commands,
      gateway_restart: true,
    },
    [
      `[clawbits] [dev] Rebuild and reinstall from the local checkout (${dir}):`,
      ...commands.map((c) => `    ${c}`),
      `[clawbits] ${RESTART_NOTE}`,
    ],
  );
  return 0;
}

/**
 * Entry point for `openclaw clawbits update`. By default prints the
 * pinned-remote upgrade command; `--from-source` prints the dev rebuild
 * recipe instead. Returns a process exit code; the caller owns
 * `process.exit`.
 */
export function runUpdateCommand(
  ctx: OpenClawPluginCliContext,
  opts: UpdateCliOptions,
): number {
  const record = readInstallRecord(ctx.config);

  // Local checkout → rebuild from source (leave the dev flow as-is). Remote
  // (or unknown) → fetch the newest compatible release and re-pin to it.
  // `--from-source` forces the local recipe regardless of detected source.
  if (opts.fromSource || record?.source === "path") {
    return recommendFromSource(opts, record);
  }

  emit(
    opts,
    {
      event: "recommendation",
      mode: "pinned-remote",
      install_source: record?.source ?? "unknown",
      installed_version: record?.version ?? null,
      commands: [PINNED_UPDATE_COMMAND],
      gateway_restart: true,
    },
    [
      "[clawbits] Fetch the newest compatible build and update to it (stays pinned):",
      `    ${PINNED_UPDATE_COMMAND}`,
      `[clawbits] ${RESTART_NOTE}`,
    ],
  );
  return 0;
}

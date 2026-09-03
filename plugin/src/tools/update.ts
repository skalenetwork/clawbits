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
// Provisioning model: agents are installed as a REMOTE ClawHub package. The
// canonical self-update re-fetches the newest compatible build:
//
//     openclaw plugins install clawhub:clawbits-openclaw-plugin --force --accept-capabilities
//
// (`--force` overwrites in place; the version-less spec resolves to the newest
// compatible release.)
//
// FLAG HISTORY - this line has churned upstream twice, so read before editing.
//
// 1. `--acknowledge-clawhub-risk` was here, was REMOVED upstream (the CLI
//    hard-errored with "does not recognize option", so every agent that ran the
//    printed command failed), and in 2026.8 the option does not exist at all -
//    its role is now `--acknowledge-install-policy-warning`. Do not reintroduce
//    the old name.
//
// 2. `--pin` was here and is REJECTED as of 2026.8 for `clawhub:` specs:
//    `src/cli/plugins-install-preflight.ts` allows it only for `npm`,
//    `official` and `bundled` sources and otherwise fails preflight with
//    "--pin is only supported with npm registry installs." (upstream test
//    `plugins-install-preflight.test.ts` covers `["clawhub:demo", "--pin"]`
//    exactly). It landed 2026-07-28 in openclaw#115464. To pin on 2026.8+, put
//    the version in the spec - `clawhub:clawbits-openclaw-plugin@0.17.0` - not
//    in a flag.
//
// 3. `--accept-capabilities` is REQUIRED as of 2026.8 whenever the declared
//    surface has changed since the last acceptance, which an upgrade normally
//    has. Clawbits is not in OpenClaw's official plugin/channel catalogs, so it
//    gets no `official` exemption from `src/plugins/capability-consent.ts`.
//    The option does not exist before 2026.8, hence the printed fallback.
//
// `--from-source` is unaffected by (2) but still needs (3) on 2026.8+.
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
const TOOLS_PACKAGE_NAME = "clawbits-openclaw-tools";
const CLAWHUB_SPEC = `clawhub:${PACKAGE_NAME}`;
const TOOLS_CLAWHUB_SPEC = `clawhub:${TOOLS_PACKAGE_NAME}`;

/** Upgrade a remote install to the newest compatible build.
 *
 *  BOTH packages, always. Since 0.17 the install is a split pair and most of
 *  what an operator means by "update Clawbits" — cron, email, usage, skills —
 *  lives in the companion, not this channel. Updating the channel alone
 *  succeeds, reports success, and silently leaves the old companion running, so
 *  the fixes the update was run for never land. The companion is pinned to the
 *  channel's resolved version so a split publication window cannot pair
 *  mismatched halves (the same rule the reef image build follows).
 *
 *  Version-less channel spec → newest compatible; `--force` overwrites the
 *  current install in place; `--accept-capabilities` clears 2026.8's consent
 *  gate. No `--pin`: see the fallback commands below. */
function remoteUpdateCommands(toolsVersion: string | null): string[] {
  const toolsSpec = toolsVersion ? `${TOOLS_CLAWHUB_SPEC}@${toolsVersion}` : TOOLS_CLAWHUB_SPEC;
  return [
    `openclaw plugins install ${CLAWHUB_SPEC} --force --accept-capabilities`,
    `openclaw plugins install ${toolsSpec} --force --accept-capabilities`,
  ];
}

/** The same pair for a pre-2026.8 gateway, which has no `--accept-capabilities`
 *  and hard-errors on an unknown option. There is one command per host era and
 *  no way to tell them apart from here — `OpenClawPluginCliContext` carries
 *  `program`, `parentPath`, `config`, `workspaceDir` and `logger`, and no host
 *  version — so both are printed and the agent picks on the error. */
function remoteUpdateFallbackCommands(toolsVersion: string | null): string[] {
  const toolsSpec = toolsVersion ? `${TOOLS_CLAWHUB_SPEC}@${toolsVersion}` : TOOLS_CLAWHUB_SPEC;
  return [
    `openclaw plugins install ${CLAWHUB_SPEC} --pin --force`,
    `openclaw plugins install ${toolsSpec} --pin --force`,
  ];
}

const UPDATE_ORDER_NOTE =
  "Run both, in that order: the companion owns cron, email, usage and skills, and an " +
  "update that moves only the channel leaves those on the old code.";
const UPDATE_VERSION_NOTE =
  `After the channel install, re-pin the companion to the channel's new version — ` +
  `\`openclaw plugins list --json\` reports it — so the two halves stay matched.`;
const UPDATE_FALLBACK_NOTE =
  "If either fails with an unknown-option error, this gateway predates OpenClaw 2026.8 — " +
  "re-run that command with `--pin --force` and without `--accept-capabilities`.";

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
  // The repo root is only the CHANNEL package. The companion is behind
  // package.tools.json and has to be staged, so a bare
  // `plugins install <dir>` updates half the install and silently strands cron,
  // email, usage and skills on the old code. `--vendor-deps` copies `typebox`
  // into the staged companion, which a path install would otherwise never
  // install (OpenClaw copies the directory; it runs no dependency step).
  //
  // Local-path installs also can never inherit capability acceptance on
  // 2026.8+: the install record pins no artifact integrity, so OpenClaw cannot
  // prove the new bytes are the ones previously approved and asks every single
  // time. Drop that flag on a pre-2026.8 gateway, which rejects it.
  return [
    `cd ${dir}`,
    "git pull --ff-only   # if this checkout tracks a remote",
    "npm run build",
    'stage="$(mktemp -d)"',
    `node stage-channel.mjs "$stage/channel" --vendor-deps`,
    `node stage-tools.mjs "$stage/tools" --vendor-deps`,
    'openclaw plugins install "$stage/channel" --force --accept-capabilities',
    'openclaw plugins install "$stage/tools" --force --accept-capabilities',
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
      "[clawbits] Drop --accept-capabilities if this gateway predates OpenClaw 2026.8.",
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

  // The channel install resolves "newest compatible" on its own, so the
  // companion cannot be pinned to that version until it has run. Leave the
  // companion spec version-less and tell the operator to re-pin, rather than
  // pinning it to the version being replaced.
  const commands = remoteUpdateCommands(null);
  emit(
    opts,
    {
      event: "recommendation",
      mode: "remote",
      install_source: record?.source ?? "unknown",
      installed_version: record?.version ?? null,
      packages: [PACKAGE_NAME, TOOLS_PACKAGE_NAME],
      commands,
      fallback_commands: remoteUpdateFallbackCommands(null),
      fallback_when: "gateway predates OpenClaw 2026.8 (rejects --accept-capabilities)",
      gateway_restart: true,
    },
    [
      "[clawbits] Fetch the newest compatible build of BOTH packages and update to it:",
      ...commands.map((c) => `    ${c}`),
      `[clawbits] ${UPDATE_ORDER_NOTE}`,
      `[clawbits] ${UPDATE_VERSION_NOTE}`,
      `[clawbits] ${UPDATE_FALLBACK_NOTE}`,
      `[clawbits] ${RESTART_NOTE}`,
    ],
  );
  return 0;
}

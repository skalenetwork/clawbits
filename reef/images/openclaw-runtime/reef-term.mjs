#!/usr/bin/env node
// Reef scoped terminal for OpenClaw agents.
//
// Served by ttyd inside the agent's microVM and reached by the agent's OWNER
// through Reef's authenticated web-UI exposure (password + unguessable
// subdomain today; trusted-proxy SSO later). It is a deliberately NARROW shell:
// it only runs `openclaw …` subcommands, so the owner can configure their agent
// (AI provider/model, channels, auth) with the same CLI people already use —
// without us re-implementing OpenClaw's config surface and without handing out a
// full shell. Set REEF_TERMINAL_SHELL=full (handled in reef-term.sh) to swap
// this for a real shell later.
//
// Safety: each line is tokenized and the child is spawned as an argv array with
// NO shell, so there is no shell-injection / command chaining (`;`, `&&`, `|`,
// backticks are all inert). The real boundaries are microVM isolation + the
// exposure auth + the egress allowlist; this wrapper is the UX guard-rail.

import readline from "node:readline";
import { spawn } from "node:child_process";

const BIN = "openclaw";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BRAND = "\x1b[38;5;203m"; // ~Studio Sphere vermilion
const WARN = "\x1b[33m";

function banner() {
  process.stdout.write(
    `\n${BRAND}${BOLD}  Reef · OpenClaw terminal${RESET}\n` +
      `${DIM}  Configure this agent with the OpenClaw CLI. Only \`openclaw …\` runs here.${RESET}\n\n` +
      `  Try:\n` +
      `    ${BOLD}openclaw configure --section model${RESET}        guided provider + model setup\n` +
      `    ${BOLD}openclaw models auth login --provider openai --device-code${RESET}\n` +
      `    ${BOLD}openclaw models set anthropic/claude-sonnet-4-6${RESET}\n` +
      `    ${BOLD}openclaw models status --probe${RESET}            check provider auth\n` +
      `    ${DIM}help · clear · exit${RESET}\n\n`,
  );
}

// Minimal shell-free tokenizer: split on whitespace, honoring '…'/"…" quotes and
// \-escapes. Produces an argv array — no globbing, no variable expansion.
function tokenize(line) {
  const out = [];
  let cur = "";
  let quote = null;
  let esc = false;
  let has = false;
  for (const ch of line) {
    if (esc) {
      cur += ch;
      esc = false;
      has = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      esc = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${BRAND}openclaw>${RESET} `,
});

banner();
rl.prompt();

let child = null;

rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return rl.prompt();
  if (t === "exit" || t === "quit") return rl.close();
  if (t === "clear") {
    process.stdout.write("\x1b[2J\x1b[H");
    return rl.prompt();
  }
  if (t === "help" || t === "?") {
    banner();
    return rl.prompt();
  }

  const argv = tokenize(t);
  if (argv[0] !== BIN) {
    process.stdout.write(
      `${WARN}Only \`openclaw …\` commands are allowed here. Type \`help\`.${RESET}\n`,
    );
    return rl.prompt();
  }

  // Hand the PTY to the child so interactive subcommands (configure, device-code
  // login, model pickers) work; resume the prompt when it exits.
  rl.pause();
  child = spawn(BIN, argv.slice(1), { stdio: "inherit" });
  child.on("exit", () => {
    child = null;
    rl.resume();
    rl.prompt();
  });
  child.on("error", (e) => {
    child = null;
    process.stdout.write(`${WARN}failed to run openclaw: ${e.message}${RESET}\n`);
    rl.resume();
    rl.prompt();
  });
});

// With a child running it owns the TTY (incl. Ctrl-C). With no child, swallow
// SIGINT so Ctrl-C just redraws the prompt instead of dropping the session.
rl.on("SIGINT", () => {
  if (!child) {
    process.stdout.write("\n");
    rl.prompt();
  }
});

rl.on("close", () => process.exit(0));

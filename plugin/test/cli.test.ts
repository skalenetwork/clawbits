import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerClawBitsCli } from "../src/cli.js";

interface FakeCommand {
  name?: string;
  desc?: string;
  options: Array<{ flags: string; description?: string; defaultValue?: unknown }>;
  handler?: (...args: unknown[]) => void | Promise<void>;
  subs: FakeCommand[];
  command(name: string): FakeCommand;
  description(text: string): FakeCommand;
  option(flags: string, description?: string, defaultValue?: unknown): FakeCommand;
  action(handler: (...args: unknown[]) => void | Promise<void>): FakeCommand;
}

function makeCommand(name?: string): FakeCommand {
  const cmd: FakeCommand = {
    name,
    options: [],
    subs: [],
    command(child: string) {
      const sub = makeCommand(child);
      this.subs.push(sub);
      return sub;
    },
    description(text: string) {
      this.desc = text;
      return this;
    },
    option(flags: string, description?: string, defaultValue?: unknown) {
      this.options.push({ flags, description, defaultValue });
      return this;
    },
    action(handler: (...args: unknown[]) => void | Promise<void>) {
      this.handler = handler;
      return this;
    },
  };
  return cmd;
}

/** Run `body` with APP_ENV temporarily set to `value`, restoring the prior
 *  value afterward so tests cannot leak env state into each other. */
function withAppEnv<T>(value: string | undefined, body: () => T): T {
  const prev = process.env["APP_ENV"];
  if (value === undefined) delete process.env["APP_ENV"];
  else process.env["APP_ENV"] = value;
  try {
    return body();
  } finally {
    if (prev === undefined) delete process.env["APP_ENV"];
    else process.env["APP_ENV"] = prev;
  }
}

describe("registerClawBitsCli", () => {
  it("registers signup + healthcheck subcommands when APP_ENV=development", () => {
    const program = makeCommand();
    let descriptors: unknown[] = [];

    const api = {
      registerCli: (
        registrar: (ctx: { program: FakeCommand; config: unknown }) => void,
        opts?: { descriptors?: unknown[] },
      ) => {
        registrar({ program, config: {} });
        descriptors = opts?.descriptors ?? [];
      },
    } as never;

    withAppEnv("development", () => registerClawBitsCli(api));

    assert.equal(program.subs.length, 1, "registers exactly one root command");
    const root = program.subs[0]!;
    assert.equal(root.name, "clawbits");
    assert.match(root.desc ?? "", /Clawbits/);

    assert.equal(root.subs.length, 4, "registers signup + update + version + healthcheck subcommands");
    const signup = root.subs.find((s) => s.name === "signup")!;
    assert.ok(signup, "registers a signup subcommand");
    assert.ok(signup.handler, "signup has an action handler");

    const update = root.subs.find((s) => s.name === "update")!;
    assert.ok(update, "registers an update subcommand");
    assert.ok(update.handler, "update has an action handler");
    assert.deepEqual(
      update.options.map((o) => o.flags).sort(),
      ["--dir <path>", "--from-source", "--json"].sort(),
    );

    const version = root.subs.find((s) => s.name === "version")!;
    assert.ok(version, "registers a version subcommand");
    assert.ok(version.handler, "version has an action handler");
    assert.deepEqual(
      version.options.map((o) => o.flags).sort(),
      ["--account <id>", "--check", "--json"].sort(),
    );

    const flagNames = signup.options.map((o) => o.flags);
    assert.deepEqual(
      flagNames.sort(),
      ["--account <id>", "--endpoint <url>", "--json", "--org-id <id>", "--signup-token <token>"].sort(),
    );

    const healthcheck = root.subs.find((s) => s.name === "healthcheck")!;
    assert.ok(healthcheck, "registers a healthcheck subcommand");
    assert.ok(healthcheck.handler, "healthcheck has an action handler");
    assert.deepEqual(
      healthcheck.options.map((o) => o.flags).sort(),
      ["--account <id>", "--json"].sort(),
    );

    assert.deepEqual(descriptors, [
      { name: "clawbits", description: "Manage the Clawbits channel plugin", hasSubcommands: true },
    ]);
  });

  it("hides the healthcheck subcommand when APP_ENV is not a dev tier", () => {
    const program = makeCommand();
    const api = {
      registerCli: (
        registrar: (ctx: { program: FakeCommand; config: unknown }) => void,
      ) => {
        registrar({ program, config: {} });
      },
    } as never;

    withAppEnv("production", () => registerClawBitsCli(api));

    const root = program.subs[0]!;
    assert.equal(root.subs.length, 3, "signup + update + version are registered in non-dev");
    assert.deepEqual(
      root.subs.map((s) => s.name).sort(),
      ["signup", "update", "version"],
    );
    assert.equal(
      root.subs.find((s) => s.name === "healthcheck"),
      undefined,
      "healthcheck must not appear in production",
    );
  });

  it("APP_ENV=plugin_development also enables the healthcheck subcommand", () => {
    // `plugin_development` is a superset of `development`: it must enable
    // everything `development` does, plus extra debug logging (covered in
    // the file-logger test). The healthcheck subcommand is the dev-tier
    // surface that gets shared.
    const program = makeCommand();
    const api = {
      registerCli: (
        registrar: (ctx: { program: FakeCommand; config: unknown }) => void,
      ) => {
        registrar({ program, config: {} });
      },
    } as never;

    withAppEnv("plugin_development", () => registerClawBitsCli(api));

    const root = program.subs[0]!;
    assert.ok(
      root.subs.find((s) => s.name === "healthcheck"),
      "healthcheck must be registered under APP_ENV=plugin_development",
    );
  });

  it("is a no-op when the host does not expose registerCli", () => {
    let called = 0;
    const api = {
      registerChannel: () => {
        called++;
      },
    } as never;
    assert.doesNotThrow(() => registerClawBitsCli(api));
    assert.equal(called, 0);
  });
});

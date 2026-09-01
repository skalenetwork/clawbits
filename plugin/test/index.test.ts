import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pluginEntry from "../src/index.js";
import { clawbitsChannelPlugin } from "../src/plugin.js";

describe("plugin entry", () => {
  it("declares the clawbits channel", () => {
    assert.equal(pluginEntry.id, "clawbits");
    assert.ok(typeof pluginEntry.name === "string" && pluginEntry.name.length > 0);
    assert.ok(typeof pluginEntry.description === "string" && pluginEntry.description.length > 0);
    assert.ok(pluginEntry.configSchema, "configSchema is populated");
  });

  it("exposes the ChannelPlugin via `channelPlugin`", () => {
    assert.strictEqual(pluginEntry.channelPlugin, clawbitsChannelPlugin);
  });

  it("has a register function", () => {
    assert.equal(typeof pluginEntry.register, "function");
  });

  it("register(api) calls api.registerChannel with the channel plugin", () => {
    const calls: Array<{ plugin: unknown }> = [];
    let registerToolCalls = 0;
    const fakeApi = {
      registerChannel(opts: { plugin: unknown }) {
        calls.push(opts);
      },
      registerTool() {
        registerToolCalls++;
      },
    };
    pluginEntry.register(fakeApi as never);
    assert.equal(calls.length, 1, "registerChannel should be called exactly once");
    assert.strictEqual(calls[0]!.plugin, clawbitsChannelPlugin);
    assert.equal(registerToolCalls, 0, "new entry must not register legacy per-operation tools");
  });

  it("warns when the slim channel is active without companion ownership", () => {
    const warnings: string[] = [];
    pluginEntry.register({
      config: { channels: { clawbits: { serviceOwner: "channel" } } },
      logger: { warn: (message: string) => warnings.push(message) },
      registerChannel() {},
    } as never);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /serviceOwner=channel/);
    assert.match(warnings[0] ?? "", /clawbits-openclaw-tools/);
  });

  it('register(api) in "cli-metadata" mode does not call registerChannel', () => {
    let channelCalls = 0;
    const fakeApi = {
      registrationMode: "cli-metadata" as const,
      registerChannel() {
        channelCalls++;
      },
    };
    pluginEntry.register(fakeApi as never);
    assert.equal(channelCalls, 0);
  });
});

describe("clawbitsChannelPlugin surface", () => {
  it("has the expected meta", () => {
    const { meta } = clawbitsChannelPlugin;
    assert.equal(meta.id, "clawbits");
    assert.equal(meta.label, "Clawbits");
    assert.equal(meta.docsPath, "/channels/clawbits");
    assert.equal(meta.exposure?.configured, true);
    assert.equal(meta.exposure?.setup, true);
  });

  it("declares capabilities for both direct messages and shared channels", () => {
    const { capabilities } = clawbitsChannelPlugin;
    // "channel" is required so core's outbound router will deliver
    // channel-typed replies back through this plugin (DMs + shared channels).
    assert.deepEqual(capabilities.chatTypes, ["direct", "channel"]);
    assert.equal(capabilities.reactions, true);
    // Outbound media is live (sendMedia uploads + posts file_ids).
    assert.equal(capabilities.media, true);
    assert.equal(capabilities.threads, false);
  });

  it("wires every adapter the host expects", () => {
    const p = clawbitsChannelPlugin;
    assert.equal(typeof p.config.listAccountIds, "function");
    assert.equal(typeof p.config.resolveAccount, "function");
    assert.equal(typeof p.config.defaultAccountId, "function");
    assert.equal(typeof p.config.isConfigured, "function");
    assert.equal(typeof p.config.unconfiguredReason, "function");

    assert.equal(typeof p.setup?.applyAccountConfig, "function");
    assert.equal(typeof p.setup?.resolveAccountId, "function");
    assert.equal(typeof p.setup?.validateInput, "function");

    assert.equal(p.setupWizard?.channel, "clawbits");
    assert.equal(typeof p.setupWizard?.getStatus, "function");
    assert.equal(typeof p.setupWizard?.configure, "function");

    assert.equal(p.outbound?.deliveryMode, "direct");
    assert.equal(typeof p.outbound?.sendText, "function");
  });

  it("reloads only on its own config prefix", () => {
    assert.deepEqual(clawbitsChannelPlugin.reload?.configPrefixes, ["channels.clawbits"]);
  });
});

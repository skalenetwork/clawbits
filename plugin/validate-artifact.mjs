#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [kind, rootArg = "."] = process.argv.slice(2);
const root = resolve(rootArg);

function artifactImport(relativePath) {
  return import(pathToFileURL(resolve(root, relativePath)).href);
}

if (kind === "channel") {
  const entry = (await artifactImport("dist/index.js")).default;
  if (entry?.id !== "clawbits" || typeof entry.register !== "function") {
    throw new Error("invalid channel entry");
  }
} else if (kind === "tools") {
  const entry = (await artifactImport("dist/tools-entry.js")).default;
  const names = [];
  entry.register({
    registrationMode: "tool-discovery",
    config: {},
    logger: {},
    runtime: {},
    registerTool(tool, options) {
      if (options?.optional !== true) {
        throw new Error(`${tool.name} is not optional`);
      }
      names.push(tool.name);
    },
    on() {},
  });
  if (names.length !== 7) {
    throw new Error(`expected 7 tools, got ${names.length}`);
  }

  // Prove companion-owned email dispatch through the installed SDK's public
  // non-channel plugin runtime surface.
  const { dispatchInboundEmail } = await artifactImport("dist/email-adapter.js");
  let dispatched;
  const channelRuntime = {
    routing: {
      resolveAgentRoute: () => ({
        agentId: "agent-1",
        accountId: "default",
        sessionKey: "agent:main:main",
      }),
    },
    session: {
      resolveStorePath: () => "/tmp/clawbits-sdk-email-smoke.json",
      readSessionUpdatedAt: () => undefined,
      recordInboundSession: async () => {},
    },
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
      formatAgentEnvelope: ({ body }) => body,
      finalizeInboundContext: (input) => input,
      dispatchReplyWithBufferedBlockDispatcher: async ({ ctx }) => {
        dispatched = ctx;
      },
    },
  };
  await dispatchInboundEmail(
    {
      cfg: { channels: { clawbits: {} } },
      accountId: "default",
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        endpoint: "https://example.invalid",
        agentId: "agent-1",
        apiKey: "key",
        channelId: "channel-1",
        knownAnswers: {},
        interAgentMode: false,
        interAgentMessageLimit: 10,
        groupChannelShimmer: true,
        channelContextBacklog: 100,
        alivePingMs: 0,
        emailEnabled: true,
        emailPollIntervalMs: 60_000,
        config: {},
      },
      channelRuntime,
      log: {},
    },
    {
      accountId: "default",
      uid: 1,
      fromAddr: "owner@example.test",
      toAddr: "agent@example.test",
      subject: "SDK smoke",
      date: "",
      bodyText: "hello",
      attachments: [],
      headers: {},
    },
  );
  if (dispatched?.EmailUid !== 1) {
    throw new Error("email did not dispatch through public runtime");
  }
} else {
  throw new Error("usage: node validate-artifact.mjs <channel|tools> [artifact-root]");
}

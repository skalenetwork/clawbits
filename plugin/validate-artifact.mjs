#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
      names.push(...(options.names ?? []), ...(options.name ? [options.name] : []));
      if (typeof tool !== "function") names.push(tool.name);
    },
    on() {},
  });
  // Checked against the manifest the artifact actually ships rather than a
  // literal count: a tool added without its `contracts.tools` entry (or the
  // reverse) is exactly the drift this gate exists to catch, and a hardcoded
  // number goes stale instead of catching it.
  const declared = JSON.parse(
    readFileSync(resolve(root, "openclaw.plugin.json"), "utf8"),
  ).contracts?.tools;
  if (!declared?.length) {
    throw new Error("manifest declares no tools under contracts.tools");
  }
  if (names.join(",") !== declared.join(",")) {
    throw new Error(
      `registered tools [${names.join(", ")}] do not match the manifest contract [${declared.join(", ")}]`,
    );
  }

  // Prove companion-owned email dispatch through the installed SDK:
  // dispatchInboundDirectDm builds the turn context with the channel runtime's
  // `inbound.buildContext`, so the stub runs the installed SDK's own builder
  // there, keeps the result, and stops before the turn reaches a model. The
  // built context proves the email extras arrive and that the email path's
  // cleared admission attestation survives the real builder.
  const { dispatchInboundEmail } = await artifactImport("dist/email-adapter.js");
  const sdk = await import(
    pathToFileURL(
      createRequire(resolve(root, "package.json")).resolve("openclaw/plugin-sdk/channel-inbound"),
    ).href
  );
  let dispatched;
  const captured = new Error("context captured");
  const channelRuntime = {
    routing: {},
    session: {},
    reply: { dispatchReplyWithBufferedBlockDispatcher: async () => {} },
    inbound: {
      buildContext: async (params) => {
        dispatched = await sdk.buildChannelInboundEventContext(params);
        throw captured;
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
    throw new Error("email did not dispatch through the channel runtime");
  }
  if (dispatched.InboundAccessAuthorized !== undefined || dispatched.ConversationRouteContextObserved !== undefined) {
    throw new Error("email turn is attested as admitted");
  }
} else {
  throw new Error("usage: node validate-artifact.mjs <channel|tools> [artifact-root]");
}

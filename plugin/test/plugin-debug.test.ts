import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isHealthcheckEnvEnabled,
  isPluginDebugEnv,
  pluginDebug,
} from "../src/file-logger.js";

/** Swap APP_ENV for the duration of `body`, restoring the prior value so
 *  tests cannot leak env state into each other. */
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

/** Capture everything `pluginDebug` writes to stderr during `body`. */
function captureStderr(body: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  (process.stderr as { write: (chunk: unknown) => boolean }).write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    body();
  } finally {
    (process.stderr as { write: typeof original }).write = original;
  }
  return chunks.join("");
}

describe("APP_ENV gates", () => {
  it("isHealthcheckEnvEnabled is true for both `development` and `plugin_development`", () => {
    assert.equal(withAppEnv("development", isHealthcheckEnvEnabled), true);
    assert.equal(withAppEnv("plugin_development", isHealthcheckEnvEnabled), true);
  });

  it("isHealthcheckEnvEnabled is false for production / unset / garbage", () => {
    assert.equal(withAppEnv("production", isHealthcheckEnvEnabled), false);
    assert.equal(withAppEnv(undefined, isHealthcheckEnvEnabled), false);
    assert.equal(withAppEnv("staging", isHealthcheckEnvEnabled), false);
    assert.equal(withAppEnv("Development", isHealthcheckEnvEnabled), false); // case-sensitive
  });

  it("isPluginDebugEnv is true only for plugin_development", () => {
    assert.equal(withAppEnv("plugin_development", isPluginDebugEnv), true);
    assert.equal(withAppEnv("development", isPluginDebugEnv), false);
    assert.equal(withAppEnv("production", isPluginDebugEnv), false);
    assert.equal(withAppEnv(undefined, isPluginDebugEnv), false);
  });
});

describe("pluginDebug", () => {
  it("writes a tagged line to stderr when APP_ENV=plugin_development", () => {
    const out = captureStderr(() => {
      withAppEnv("plugin_development", () => {
        pluginDebug("Received. Clawbits DM delivery is working.");
      });
    });
    assert.match(out, /\[plugin-debug\] Received\. Clawbits DM delivery is working\./);
  });

  it("is a silent no-op for APP_ENV=development (healthcheck tier, not debug tier)", () => {
    const out = captureStderr(() => {
      withAppEnv("development", () => {
        pluginDebug("should not appear");
      });
    });
    assert.equal(out, "", `expected no stderr output, got: ${JSON.stringify(out)}`);
  });

  it("is a silent no-op for production / unset", () => {
    const prodOut = captureStderr(() => {
      withAppEnv("production", () => pluginDebug("nope"));
    });
    const unsetOut = captureStderr(() => {
      withAppEnv(undefined, () => pluginDebug("nope"));
    });
    assert.equal(prodOut, "");
    assert.equal(unsetOut, "");
  });
});

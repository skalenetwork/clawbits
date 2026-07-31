import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LobsterTalkPlugin } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = resolve(__dirname, "../../lobstertalk_int8.onnx");
const hasModel = existsSync(MODEL_PATH);

describe("LobsterTalkPlugin", () => {
  it("throws ERR_UNINITIALIZED if predict called before initialize", async () => {
    const p = new LobsterTalkPlugin();
    await assert.rejects(() => p.predictAddressee("hello"), /ERR_UNINITIALIZED/);
  });

  it("exposes extractFeatures as instance method", () => {
    const p = new LobsterTalkPlugin();
    const v = p.extractFeatures("hello");
    assert.equal(v.length, 64);
  });
});

describe("LobsterTalkPlugin: ONNX inference", { skip: !hasModel }, () => {
  let plugin: LobsterTalkPlugin;

  before(async () => {
    plugin = new LobsterTalkPlugin();
    await plugin.initialize(MODEL_PATH);
  });

  it("throws ERR_INVALID_INPUT for empty message", async () => {
    await assert.rejects(() => plugin.predictAddressee(""), /ERR_INVALID_INPUT/);
  });

  it("returns a PredictionResult with confidence in [0,1]", async () => {
    const r = await plugin.predictAddressee("hello there", {
      sender: "alice",
      activeUsers: ["alice", "bob"],
    });
    assert.ok(r.confidence >= 0 && r.confidence <= 1, `bad confidence: ${r.confidence}`);
    assert.ok(r.targetClass === "AMBIGUOUS" || Number.isInteger(r.targetClass));
  });

  it("is deterministic for the same input", async () => {
    const ctx = { sender: "alice", activeUsers: ["alice", "bob"] };
    const a = await plugin.predictAddressee("good morning", ctx);
    const b = await plugin.predictAddressee("good morning", ctx);
    assert.deepEqual(a, b);
  });
});


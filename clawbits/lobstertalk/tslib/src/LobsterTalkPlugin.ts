// @ts-ignore - some workspace layouts fail to resolve nested node_modules in-editor.
// Runtime resolution is provided by the installed dependency.
import * as ort from "onnxruntime-node";

import { extractFeatures } from "./features";
import type { ChatContext, PredictionResult } from "./types";

/**
 * LobsterTalk OpenClaw inference engine.
 *
 * Loads the INT8 ONNX model and provides `predictAddressee()`.
 */
export class LobsterTalkPlugin {
  private session: ort.InferenceSession | null = null;

  private readonly FEATURE_DIM = 64;
  private readonly AMBIGUITY_THRESHOLD = 0.45;

  async initialize(modelPath: string = "./lobstertalk_int8.onnx"): Promise<void> {
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
  }

  public extractFeatures(message: string, context?: ChatContext): Float32Array {
    return extractFeatures(message, context);
  }

  async predictAddressee(message: string, context?: ChatContext): Promise<PredictionResult> {
    if (!this.session) throw new Error("ERR_UNINITIALIZED: Plugin not initialized.");
    if (!message || typeof message !== "string") {
      throw new Error("ERR_INVALID_INPUT: Message text is required.");
    }

    const featureVector = this.extractFeatures(message, context);
    const tensorX = new ort.Tensor("float32", featureVector, [1, this.FEATURE_DIM]);

    const results = await this.session.run({ input_X: tensorX });
    const out = results.output_logits;
    if (!out) {
      throw new Error("ERR_MODEL_OUTPUT: ONNX model did not return output_logits.");
    }

    const logits = Array.from(out.data as Float32Array);
    const probabilities = softmax(logits);

    let maxConfidence = -Infinity;
    let targetClass = 0;
    for (let i = 0; i < probabilities.length; i++) {
      const p = probabilities[i];
      if (p > maxConfidence) {
        maxConfidence = p;
        targetClass = i;
      }
    }

    if (maxConfidence < this.AMBIGUITY_THRESHOLD) {
      return { targetClass: "AMBIGUOUS", confidence: maxConfidence };
    }

    return { targetClass, confidence: maxConfidence };
  }
}

function softmax(logits: number[]): number[] {
  const maxLogit = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - maxLogit));
  const sumExps = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sumExps);
}


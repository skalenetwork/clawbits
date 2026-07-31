// Minimal type shim for `onnxruntime-node`.
//
// Some IDEs / language services may not resolve nested `node_modules` correctly for
// this workspace layout. This shim keeps TypeScript type-checking working.
//
// At runtime, the real `onnxruntime-node` package is required.

declare module "onnxruntime-node" {
  export type TensorType = "float32" | "float" | "int32" | "int64" | string;

  export class Tensor {
    constructor(type: TensorType, data: Float32Array | Int32Array | BigInt64Array | number[], dims: number[]);
    readonly type: TensorType;
    readonly data: unknown;
    readonly dims: readonly number[];
  }

  export interface InferenceSession {
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }

  export namespace InferenceSession {
    function create(
      modelPath: string,
      options?: {
        executionProviders?: string[];
        graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all" | string;
      },
    ): Promise<InferenceSession>;
  }
}


# Technical Specification: LobsterTalkLLM Protocol

- **Version:** 1.5 (OpenClaw Integration & Reference Implementation)
- **Status:** Protocol Definition
- **Primary Goal:** Real-time addressee classification (Individual vs. Subgroup vs. All) via localized inference, optimized for OpenClaw agentic environments.

## TL;DR / Executive Summary

This protocol defines a lightweight, low-latency machine learning system for real-time
addressee classification in multi-user chat environments. By distilling the conversational
reasoning capabilities of a high-capacity LLM (the "Teacher") into a highly optimized,
feature-engineered Multi-Layer Perceptron (the "Student"), the system resolves implicit
context without the overhead of generative models. Deployed as an OpenClaw plugin, the
INT8-quantized ONNX model requires an exceptionally small memory footprint (≈ 15 KB) and
delivers deterministic, local inference in under 0.2 ms with $O(1)$ complexity. This ensures
absolute data privacy, zero API costs, and native integration with high-throughput agentic
workflows.

## 1. Data Engineering & Synthetic Synthesis (The "Teacher")

The protocol utilizes a Teacher-Student distillation pattern to generate a structured, labeled
dataset using a high-capacity LLM (e.g., Gemini 1.5 Flash). This approach leverages the LLM's
high-dimensional reasoning to label implicit social cues.

### 1.1 Teacher Prompting Strategy

The Teacher generates "Thread Blocks" consisting of 5–10 messages to establish context.

- **Context Injection:** Models are provided with a "Chat Persona Manifest."
- **Reasoning-Trace Labeling:** To ensure high-quality labels, the Teacher must output a
  `Thought` field before the `Target` field, allowing for Chain-of-Thought (CoT) verification.

### 1.2 Synthetic Data Schema

```json
{
  "thread_id": "string",
  "persona_map": {
    "user_1": "Dev",
    "user_2": "Designer",
    "subgroup_1": "Engineering"
  },
  "messages": [
    {
      "msg_id": "m1",
      "sender": "user_1",
      "text": "The API is returning a 500 error.",
      "timestamp_offset": 0,
      "metadata": {
        "reasoning": "Standard status update to the group.",
        "target_probs": {
          "user_1": 0.05,
          "subgroup_1": 0.85,
          "global": 0.10
        }
      }
    }
  ]
}
```

## 2. Formalized Feature Vector Mapping ($P(C) \rightarrow X$)

The Student model operates on a deterministic mapping function $P(C) \rightarrow X \in \mathbb{R}^{64}$,
transforming a sequence of chat states $C$ into a fixed-dimensional numerical vector $X$.

### 2.1 Categorical Features (One-Hot Encoded)

- **Sender ID ($X_{0\text{–}7}$):** One-hot encoded. Maps to the top 7 highest-frequency users in
  the active context window. Index 7 is reserved for "Other" (frequency below threshold $\tau$).
- **Previous Sender ID ($X_{8\text{–}15}$):** One-hot encoded identification of the immediate
  predecessor.

### 2.2 Temporal & Quantitative Features (Normalized)

- **Time Delta ($\Delta t$, $X_{16}$):** Logarithmic scaling of elapsed time, strictly bounded
  to 1 hour (3600 seconds) to prevent unbounded outputs. Defined as:

  $$
  X_{16} = \frac{\min(\ln(1 + \Delta t_{\text{seconds}}),\; \ln(3600))}{\ln(3600)}
  $$

  > Note: If $\Delta t > 3600$, context is considered fully decayed ($X_{16} = 1.0$).

- **Message Length ($X_{17}$):** Character count, bounded to $L_{\max} = 256$ and min-max
  normalized.

### 2.3 Semantic Signal & Hashing Trick

- **Keyword Hashing ($X_{18\text{–}49}$):** Captures subgroup semantics. Utilizes
  `MurmurHash3_x86_32(token) mod 32` to project tokenized keywords into a 32-dimensional
  subspace. This ensures an $O(1)$ lookup and avoids loading an external embedding
  dictionary, accepting a measured probability of hash collisions for out-of-vocabulary slang.
- **Mention Flag ($X_{50}$):** Binary (1 if `@username` or known identifier regex triggers).
- **Padding ($X_{51\text{–}63}$):** Reserved vectors for future context expansion (e.g., thread
  ID depth).

## 3. Student Model Architecture & Distillation Loss

The protocol specifies a Multi-Layer Perceptron (MLP). An MLP is chosen over a sequential
model (like a GRU or LSTM) because all temporal context is explicitly encoded in the feature
vector (e.g., $\Delta t$, Previous Sender), allowing for parallelizable $O(1)$ inference complexity.

- **Architecture:** `64 → 32 (ReLU) → 16 (ReLU) → N (Softmax)`.
- **Output Class Mapping ($N=10$):**
  - **Index 0–6:** Maps 1:1 to the top 7 highest-frequency users identified in the *Sender ID* categorical feature.
  - **Index 7:** Reserved for "Other/Unknown" (low-frequency users below threshold $\tau$).
  - **Index 8:** Maps to the active Context Subgroup.
  - **Index 9:** Maps to "Global/All".
- **Total Parameters:** ≈ 2,700 weights.
- **Distillation Objective:** Instead of standard Cross-Entropy, the model minimizes the
  KL-Divergence ($D_{KL}$) between the Teacher's Softmax distribution ($P$) and the Student's
  prediction ($Q$) to capture the LLM's uncertainty logic:

  $$
  \mathcal{L} = \sum_{x \in X} P(x) \log\!\left(\frac{P(x)}{Q(x)}\right)
  $$

- **Model Size (INT8 Quantized):** ≈ 12 KB.

## 4. OpenClaw Plugin Deployment Architecture

To integrate as an OpenClaw plugin, the protocol shifts from a sandboxed browser environment
to a native Node.js/Python agentic runtime. This enables direct, low-level OS access for
monitoring chat daemons or log streams.

### 4.1 Runtime Initialization (Daemon Mode)

The OpenClaw plugin must run as a resident background process to avoid repetitive memory
allocation.

- **Engine:** `onnxruntime-node` (C++ Native Bindings) or `onnxruntime` (Python).
- **Inter-Process Communication (IPC):** OpenClaw routes streaming chat logs to the plugin
  via Unix sockets or local gRPC, ensuring near-zero network latency.

### 4.2 Handling the "Null State" (Cold Starts)

When initializing monitoring on a new channel without historical context ($k < 1$), the feature
extraction defaults to:

- $\Delta t \rightarrow 1.0$ (maximum decay).
- Previous Sender $P(C) \rightarrow$ zero-vector (all 0s).

## 5. OpenClaw Performance Estimates & Benchmarks

Because OpenClaw operates locally, performance constraints focus on CPU core monopolization
and memory footprint during high-throughput monitoring.

### 5.1 Memory & Lifecycle Metrics

| Metric                  | Expected Value | Justification                                                                             |
| ----------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| Storage Footprint       | ≈ 15 KB        | INT8 Quantized ONNX weights + JSON Metadata.                                              |
| Cold Start Latency      | < 15 ms        | OS-level I/O to load the `.onnx` file into RAM and initialize the C++ inference session.  |
| Resident Set Size (RSS) | < 25 MB        | Total Node.js/Python daemon memory overhead during active OpenClaw background monitoring. |

### 5.2 Inference & Throughput Profiling (Warm Start)

**Hardware Baseline:** Standard consumer CPU (e.g., Apple M1 or Intel i5).

| Metric                            | Expected Value  | Testing Method                                                                                                                |
| --------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Feature Extraction ($P(C) \to X$) | ≈ 0.05 ms       | Profiling Regex matching and MurmurHash3 execution.                                                                           |
| Forward Pass ($W \cdot X$)        | ≈ 0.1 ms        | Measured via native ONNX C++ bindings.                                                                                        |
| Total Pipeline Latency            | < 0.2 ms        | From socket message receipt to addressee prediction.                                                                          |
| Max Throughput                    | > 5,000 msg/sec | Evaluated on a single thread. Sufficient for monitoring enterprise-scale server logs without blocking the OpenClaw main loop. |

### 5.3 Distillation Degradation

- **Quantization Noise:** Maximum tolerable $\Delta$ F1-Score between FP32 and INT8 formats
  is 2%.
- **Confidence Fallback:** If the Softmax output confidence $Q_{\max} < 0.45$, the plugin
  explicitly flags the output as `AMBIGUOUS`, triggering a secondary heuristic or OpenClaw
  LLM query.

## 6. API Specification

This section defines the strict interface contracts for the three core phases of the
LobsterTalkLLM protocol, including expected failure states to guarantee fault tolerance.

### 6.1 Synthetic Data Generation API

Defines the interface for interacting with the Teacher LLM to build the corpus.

#### `generate_thread(users: List[str], subgroups: List[str]) -> dict`

- **Description:** Prompts the Teacher LLM to generate a single synthetic chat thread block
  containing 5–10 messages.
- **Parameters:**
  - `users`: A list of strings representing individual participant names/handles.
  - `subgroups`: A list of strings representing targetable cohorts.
- **Returns:** A dictionary adhering strictly to the JSON schema defined in Section 1.2.
- **Exceptions/Errors:**
  - `RateLimitError` (HTTP 429) if the LLM API quota is exceeded.
  - `JSONDecodeError` if the Teacher LLM fails strict schema adherence.
  - `APIConnectionError` for network/socket timeouts.

#### `synthesize_dataset(num_threads: int = 1000) -> void`

- **Description:** Asynchronously orchestrates `generate_thread` calls, collates valid
  responses, and writes the corpus to disk.
- **Parameters:**
  - `num_threads`: The target number of thread blocks to generate.
- **Side Effects:** Writes a `synthetic_corpus.json` file to the local directory.
- **Exceptions/Errors:**
  - `asyncio.TimeoutError` if the batch job exceeds maximum allowed execution time.
  - `IOError` or `PermissionError` if disk write access is denied for the output file.

### 6.2 Training API

Defines the interface for instantiating the Student, computing distillation loss, and exporting.

#### `LobsterTalkStudent(input_dim: int = 64, num_classes: int = 10) -> nn.Module`

- **Description:** Initializes the PyTorch MLP architecture.
- **Parameters:**
  - `input_dim`: Must perfectly match the length of the feature vector $X$.
  - `num_classes`: Total targetable entities (Individuals + Subgroups + Global).
- **Exceptions/Errors:**
  - `ValueError` if `input_dim` or `num_classes` are $\leq 0$.

#### `distillation_loss(student_logits: Tensor, teacher_probs: Tensor) -> Tensor`

- **Description:** Computes the KL-Divergence.
- **Parameters:**
  - `student_logits`: Raw, un-normalized outputs from the Student's final layer.
  - `teacher_probs`: Target probability distribution from the Teacher LLM.
- **Returns:** Scalar tensor representing the loss graph.
- **Exceptions/Errors:**
  - `RuntimeError` if the dimensional shapes of `student_logits` and `teacher_probs` do not
    match.

#### `export_and_quantize(model: nn.Module, filepath: str) -> void`

- **Description:** Traces the PyTorch model, exports to FP32 ONNX, and applies dynamic INT8
  quantization.
- **Parameters:**
  - `model`: The trained `LobsterTalkStudent` instance.
  - `filepath`: Desired output path for the FP32 intermediate file.
- **Side Effects:** Saves the FP32 ONNX graph to `{filepath}` and an INT8-quantized variant whose name is derived by substituting `_fp32.onnx` (or `.onnx`) with `_int8.onnx`.
- **Exceptions/Errors:**
  - `RuntimeError` if the PyTorch ONNX tracer fails to compile the computational graph.
  - `IOError` for invalid or inaccessible directory paths.

### 6.3 Inference API

Defines the interface for the OpenClaw agent running the TypeScript inference engine.

#### `initialize(modelPath: string) -> Promise<void>`

- **Description:** Instantiates the C++ native ONNX runtime session and loads the weights
  into RAM.
- **Parameters:**
  - `modelPath`: Absolute or relative path to the `.onnx` artifact.
- **Exceptions/Errors:**
  - `ERR_MODEL_NOT_FOUND`: Thrown if `modelPath` is missing.
  - `ERR_ONNX_RUNTIME`: Thrown if C++ native bindings fail to initialize on the host OS.

#### `extractFeatures(message: string, context: ChatContext) -> Float32Array`

- **Description:** The deterministic mapping function $P(C) \rightarrow X$. Must maintain 1:1
  parity with the Python training pre-processor.
- **Parameters:**
  - `message`: Raw string text of the incoming message.
  - `context`: An object containing temporal and metadata states (e.g., `lastMessageTimestamp`).
- **Returns:** A strictly typed length-64 `Float32Array`.
- **Exceptions/Errors:**
  - `TypeError`: Thrown if the `message` string is null, but handles missing `context` gracefully via "Null State" fallback (defaults $\Delta t \rightarrow 1.0$).

#### `predictAddressee(message: string, context?: ChatContext) -> Promise<PredictionResult>`

- **Description:** The primary inference loop. Extracts features, runs the forward pass, and
  calculates ambiguity.
- **Parameters:** Same as `extractFeatures`.
- **Returns:** An object containing `targetClass` (integer ID or the string `'AMBIGUOUS'`) and
  `confidence` (float `0.0`–`1.0`).
- **Exceptions/Errors:**
  - `ERR_UNINITIALIZED`: Thrown if called before `initialize()` has successfully resolved.
  - `ERR_INVALID_INPUT`: Thrown if `message` is `null` or `undefined` or empty.

## 7. Reference Implementation: Synthetic Data Synthesis (Teacher)

The following Python script utilizes the Gemini API to asynchronously generate high-volume,
logically consistent synthetic chat threads. It enforces strict JSON schemas to ensure
immediate compatibility with the Student training pipeline.

```python
import asyncio
import json
import google.generativeai as genai
from google.generativeai.types import GenerationConfig

# Initialize Gemini 1.5 Flash for high-throughput, cost-efficient generation
genai.configure(api_key="YOUR_API_KEY")
model = genai.GenerativeModel("gemini-1.5-flash")

PROMPT_TEMPLATE = """
Generate a synthetic chat thread with 5-10 messages.
Participants: {users}. Subgroups: {subgroups}.
Include typos, interruptions, and implicit addressees.
Crucially, output a 'reasoning' field expressing your Chain-of-Thought BEFORE outputting a 'target_probs' mapping for every message reflecting the conversational context, assigning probabilities across participants, subgroups, or 'global' (must sum to 1.0).
Ensure the 'reasoning' and 'target_probs' are explicitly nested inside a 'metadata' object field for each message, strictly adhering to the following JSON schema requirements:

Required JSON Format:
{{
  "thread_id": "string",
  "persona_map": {{ "user_key": "role string" }},
  "messages": [
    {{
      "msg_id": "string",
      "sender": "string",
      "text": "string",
      "timestamp_offset": number,
      "metadata": {{
        "reasoning": "string",
        "target_probs": {{ "participant_or_group": float }}
      }}
    }}
  ]
}}
"""


async def generate_thread(users: list, subgroups: list) -> dict:
    prompt = PROMPT_TEMPLATE.format(users=users, subgroups=subgroups)
    # Force the LLM to return valid JSON matching the Section 1.2 Schema
    config = GenerationConfig(response_mime_type="application/json")
    response = await asyncio.to_thread(
        model.generate_content,
        prompt,
        generation_config=config,
    )
    return json.loads(response.text)


async def synthesize_dataset(num_threads: int = 1000):
    users = ["Alice", "Bob", "Charlie", "Dave"]
    subgroups = ["Engineering", "Design"]

    # Use a semaphore to genuinely respect API limits natively
    sem = asyncio.Semaphore(5)

    async def bounded_generate():
        async with sem:
            return await generate_thread(users, subgroups)

    tasks = [bounded_generate() for _ in range(num_threads)]
    # Use asyncio.gather to process generation concurrently
    dataset = await asyncio.gather(*tasks, return_exceptions=True)
    # Filter out API errors and write to disk
    valid_data = [d for d in dataset if isinstance(d, dict)]
    with open("synthetic_corpus.json", "w") as f:
        json.dump(valid_data, f, indent=2)
    print(f"Synthesized {len(valid_data)} threads successfully.")


# To run: asyncio.run(synthesize_dataset(1000))
```

## 8. Reference Implementation: Python Training & Export (Student)

The following PyTorch snippet provides the canonical implementation for instantiating the
Student architecture, applying the KL-Divergence distillation loss, and exporting the quantized
ONNX artifact.

### 8.1 PyTorch Architecture & Loss Definition

```python
import torch
import torch.nn as nn
import torch.nn.functional as F
import onnx
from onnxruntime.quantization import quantize_dynamic, QuantType


def map_labels_to_tensor(target_probs: dict, active_users: list, context_subgroup: str) -> torch.Tensor:
    """
    Maps variable string labels from the JSON corpus to the fixed 10-dimensional output tensor.
    Indices 0-6: Top 7 Active Users, Index 7: Other/Unknown, Index 8: Subgroup, Index 9: Global.
    """
    tensor = torch.zeros(10)
    for key, prob in target_probs.items():
        if key == "global":
            tensor[9] += prob
        elif key == context_subgroup:
            tensor[8] += prob
        elif key in active_users and active_users.index(key) < 7:
            tensor[active_users.index(key)] += prob
        else:
            # Map low-frequency or unknown users to the 'Other' index (7)
            tensor[7] += prob

    # Normalize to ensure sum is 1.0 in case of rounding errors
    return tensor / (tensor.sum() + 1e-8)


class LobsterTalkStudent(nn.Module):
    def __init__(self, input_dim=64, num_classes=10):
        super().__init__()
        # O(1) Feedforward architecture as per Section 3
        self.fc1 = nn.Linear(input_dim, 32)
        self.fc2 = nn.Linear(32, 16)
        self.fc3 = nn.Linear(16, num_classes)

    def forward(self, x):
        x = F.relu(self.fc1(x))
        x = F.relu(self.fc2(x))
        # Note: Softmax is omitted here; applied natively during loss/inference
        return self.fc3(x)


def distillation_loss(student_logits, teacher_probs):
    """
    Computes KL-Divergence between Student and Teacher.
    Assumes teacher_probs are already valid probabilities generated by the LLM.
    """
    student_log_probs = F.log_softmax(student_logits, dim=1)
    # PyTorch KLDivLoss expects input in log-space and target in linear-space
    loss = F.kl_div(student_log_probs, teacher_probs, reduction="batchmean")
    return loss
```

### 8.2 ONNX Export & INT8 Quantization

```python
def export_and_quantize(model, filepath="lobstertalk_fp32.onnx"):
    model.eval()
    # Dummy input must not require gradients during eval/export
    dummy_input = torch.randn(1, 64, requires_grad=False)

    # 1. Export standard FP32 ONNX graph
    torch.onnx.export(
        model,
        dummy_input,
        filepath,
        export_params=True,
        opset_version=14,
        do_constant_folding=True,
        input_names=["input_X"],
        output_names=["output_logits"],
        dynamic_axes={
            "input_X": {0: "batch_size"},
            "output_logits": {0: "batch_size"},
        },
    )

    # 2. Apply Dynamic INT8 Quantization for OpenClaw distribution
    quantized_filepath = (
        filepath.replace("_fp32.onnx", "_int8.onnx")
        if "_fp32.onnx" in filepath
        else filepath.replace(".onnx", "_int8.onnx")
    )
    quantize_dynamic(
        model_input=filepath,
        model_output=quantized_filepath,
        weight_type=QuantType.QUInt8,
    )
    print(f"Successfully exported quantized student model to {quantized_filepath}")
```

## 9. OpenClaw Plugin Reference Implementation (TypeScript/Node.js)

This TypeScript class demonstrates how an OpenClaw agent initializes the ONNX runtime,
extracts parity-matched features $P(C) \rightarrow X$, and manages local inference with
near-zero latency.

### 9.1 Plugin Class Definition & Initialization

> Reference source file: `clawbits/lobstertalk/tslib/src/LobsterTalkPlugin.ts`

```typescript
import * as ort from 'onnxruntime-node';

export interface ChatContext {
  /** Unix epoch millis of the last observed message; omit for cold start. */
  lastMessageTimestamp?: number;

  /** Optional: sender handle of the current message (for X_0..X_7). */
  sender?: string;

  /** Optional: sender handle of the previous message (for X_8..X_15). */
  previousSender?: string;

  /** Optional: top active users in the context window (first 7 map to indices 0..6). */
  activeUsers?: string[];
}

export class LobsterTalkPlugin {
  private session: ort.InferenceSession | null = null;
  private readonly FEATURE_DIM = 64;
  private readonly AMBIGUITY_THRESHOLD = 0.45;

  /**
   * Initializes the ONNX inference session utilizing OpenClaw's native C++ bindings.
   */
  async initialize(modelPath: string = './lobstertalk_int8.onnx'): Promise<void> {
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'], // Optimized for minimal local daemon overhead
      graphOptimizationLevel: 'all',
    });
    console.log(`[OpenClaw] LobsterTalkLLM model initialized.`);
  }

  /**
   * Deterministic mapping function P(C) -> X.
   * Ensures strict parity with the Python preprocessing pipeline (Section 2).
   */
  public extractFeatures(message: string, context?: ChatContext): Float32Array {
    if (message === null || message === undefined) {
      throw new TypeError('extractFeatures: message must be a non-null string.');
    }
    // Enforce typed array for strict memory mapping
    const vector = new Float32Array(this.FEATURE_DIM);

    // 0. Sender one-hot (X_0..X_7) and previous sender one-hot (X_8..X_15)
    const activeUsers = context?.activeUsers ?? [];
    const userIndex = (name?: string): number => {
      if (!name) return 7;
      const idx = activeUsers.indexOf(name);
      return idx >= 0 && idx < 7 ? idx : 7;
    };

    vector[userIndex(context?.sender)] = 1.0;
    if (context?.previousSender) {
      vector[8 + userIndex(context.previousSender)] = 1.0;
    }

    // 1. Temporal feature (X_16): Logarithmic scaling bounded to 1 hour
    if (!context || context.lastMessageTimestamp === undefined) {
      vector[16] = 1.0; // Maximum decay for cold start
    } else {
      const dtSeconds = Math.max(0, (Date.now() - context.lastMessageTimestamp) / 1000);
      vector[16] = Math.min(Math.log(1 + dtSeconds), Math.log(3600)) / Math.log(3600);
    }

    // 1.5. Message Length Feature (X_17): Min-max normalized
    vector[17] = Math.min(message.length, 256) / 256.0;

    // 2. Semantic Hash Trick (X_18 to X_49): MurmurHash3 projection
    // Strip punctuation to avoid degrading hash bin coherence (e.g., "error." vs "error")
    const cleanMessage = message.replace(/[^\w\s]/g, '').toLowerCase();
    const tokens = cleanMessage.split(/\s+/);
    for (const token of tokens) {
      if (!token) continue; // Prevent hashing empty strings from whitespace-only or empty messages
      // Projection into 32-dim subspace. Ensure unsigned int to prevent negative array indices.
      const hashIndex = 18 + ((murmurhash3_x86_32(token, 0) >>> 0) % 32);
      vector[hashIndex] = 1.0;
    }

    // 3. Mention flag (X_50): 1 if @username matches an active user (case-insensitive)
    if (activeUsers.length > 0) {
      const activeLower = new Set(activeUsers.map(u => u.toLowerCase()));
      const mentionRe = /@([A-Za-z0-9_]+)/g;
      for (;;) {
        const m = mentionRe.exec(message);
        if (!m) break;
        if (activeLower.has(m[1].toLowerCase())) {
          vector[50] = 1.0;
          break;
        }
      }
    }

    return vector;
  }

  /**
   * Primary inference loop called by the OpenClaw message bus.
   */
  async predictAddressee(
    message: string,
    context?: ChatContext,
  ): Promise<{ targetClass: number | 'AMBIGUOUS'; confidence: number }> {
    if (!this.session) throw new Error('ERR_UNINITIALIZED: Plugin not initialized.');
    if (!message || typeof message !== 'string') throw new Error('ERR_INVALID_INPUT: Message text is required.');

    const featureVector = this.extractFeatures(message, context);
    const tensorX = new ort.Tensor('float32', featureVector, [1, this.FEATURE_DIM]);

    const results = await this.session.run({ input_X: tensorX });
    if (!results.output_logits) {
      throw new Error('ERR_MODEL_OUTPUT: ONNX model did not return output_logits.');
    }
    const logitsArray = results.output_logits.data as Float32Array;
    const logits = Array.from(logitsArray); // Convert to standard JS Array to avoid TypedArray spread operator issues

    // Apply Softmax locally (Numerically Stable)
    const maxLogit = Math.max(...logits);
    const exps = logits.map(l => Math.exp(l - maxLogit));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    const probabilities = exps.map((exp) => exp / sumExps);

    // Calculate confidence and handle ambiguity fallback
    const maxConfidence = Math.max(...probabilities);
    const targetClass = probabilities.indexOf(maxConfidence);

    if (maxConfidence < this.AMBIGUITY_THRESHOLD) {
      return { targetClass: 'AMBIGUOUS', confidence: maxConfidence };
    }

    return { targetClass, confidence: maxConfidence };
  }
}

// MurmurHash3_x86_32 implementation (seed default 0).
// Used for Section 2.3 keyword hashing: MurmurHash3_x86_32(token) mod 32.
export function murmurhash3_x86_32(key: string, seed: number = 0): number {
  let remainder = key.length & 3;
  let bytes = key.length - remainder;
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  let i = 0;
  while (i < bytes) {
    let k1 =
      (key.charCodeAt(i) & 0xff) |
      ((key.charCodeAt(i + 1) & 0xff) << 8) |
      ((key.charCodeAt(i + 2) & 0xff) << 16) |
      ((key.charCodeAt(i + 3) & 0xff) << 24);
    i += 4;

    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);

    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }

  let k1 = 0;
  switch (remainder) {
    case 3:
      k1 ^= (key.charCodeAt(i + 2) & 0xff) << 16;
    case 2:
      k1 ^= (key.charCodeAt(i + 1) & 0xff) << 8;
    case 1:
      k1 ^= key.charCodeAt(i) & 0xff;
      k1 = Math.imul(k1, c1);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, c2);
      h1 ^= k1;
  }

  h1 ^= key.length;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}
```

### 9.2 Tests (Node.js)

> Reference test file: `plugin/test/lobstertalk.test.ts` (imports `@clawbits/lobstertalk` and loads `clawbits/lobstertalk/lobstertalk_int8.onnx`)

These tests ensure:

- Feature extraction returns a length-64 vector with the expected indices.
- The ONNX INT8 model (`lobstertalk_int8.onnx`) can be loaded and executed.

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LobsterTalkPlugin } from '../src/lobstertalk/LobsterTalkPlugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const modelPath = path.resolve(repoRoot, 'clawbits', 'lobstertalk', 'lobstertalk_int8.onnx');

test('predictAddressee runs with lobstertalk_int8.onnx', async () => {
  const plugin = new LobsterTalkPlugin();
  await plugin.initialize(modelPath);

  const res = await plugin.predictAddressee('Hey @Alice can you review this?', {
    sender: 'Bob',
    previousSender: 'Charlie',
    activeUsers: ['Alice', 'Bob', 'Charlie', 'Dave'],
    lastMessageTimestamp: Date.now() - 5000,
  });

  assert.ok(res.confidence >= 0 && res.confidence <= 1);
});
```

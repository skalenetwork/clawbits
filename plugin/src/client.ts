import { captureHttpExchange } from "openclaw/plugin-sdk/proxy-capture";
import { ClawBitsError } from "./errors.js";
import { setTraceSink, type TraceSpan } from "./file-logger.js";
import type { ClawBitsRequestMetric } from "./latency-metrics.js";
import type { ChallengeAnswer } from "./types.js";
import { PLUGIN_VERSION, PLUGIN_VERSION_HEADER } from "./version.js";

export interface ClientLogger {
  debug: (msg: string, meta?: object) => void;
}

export interface RequestOptions {
  json?: unknown;
  body?: BodyInit | Uint8Array;
  headers?: Record<string, string>;
  challenge?: ChallengeAnswer;
  auth?: boolean;
  /** Abort the request (e.g. a caller-supplied timeout). Without one, a stalled
   *  connection blocks on Node fetch's ~300s (undici) header/body default — long
   *  enough to freeze a single-flight loop like the automations reconciler. */
  signal?: AbortSignal;
}

function formatDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export class ClawBitsClient {
  private baseUrl: string;
  private apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  readonly logger: ClientLogger | undefined;
  readonly onRequestMetric: ((metric: ClawBitsRequestMetric) => void) | undefined;

  setApiKey(key: string | undefined): void {
    this.apiKey = key;
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  setEndpoint(endpoint: string): void {
    this.baseUrl = endpoint.replace(/\/+$/, "");
  }

  getEndpoint(): string {
    return this.baseUrl;
  }

  constructor({
    endpoint,
    apiKey,
    fetchImpl,
    logger,
    onRequestMetric,
  }: {
    endpoint: string;
    apiKey?: string;
    fetchImpl?: typeof fetch;
    logger?: ClientLogger;
    onRequestMetric?: (metric: ClawBitsRequestMetric) => void;
  }) {
    this.baseUrl = endpoint.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.logger = logger;
    this.onRequestMetric = onRequestMetric;
    this.registerTraceSink();
  }

  /** Ship plugin trace spans to the standalone viewer's ring
   *  (``POST /api/trace/spans``) in addition to the local trace log. Raw,
   *  unauthenticated, fire-and-forget against the current base URL — never
   *  carries a trace header (so it can't recurse) and swallows every failure;
   *  tracing must never perturb a turn. */
  private registerTraceSink(): void {
    setTraceSink((span: TraceSpan) => {
      try {
        void this.fetchImpl(`${this.baseUrl}/api/trace/spans`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(span),
        }).catch(() => {});
      } catch {
        /* best-effort */
      }
    });
  }

  encodePath(...segments: string[]): string {
    return segments.map((s) => encodeURIComponent(s)).join("/");
  }

  async rawRequest(
    method: string,
    path: string,
    opts: Pick<RequestOptions, "headers" | "auth"> & { signal?: AbortSignal } = {}
  ): Promise<Response> {
    const { headers: extraHeaders = {}, auth, signal } = opts;
    const reqHeaders: Record<string, string> = { ...extraHeaders };
    reqHeaders[PLUGIN_VERSION_HEADER] = PLUGIN_VERSION;
    if (auth !== false && this.apiKey) {
      reqHeaders["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: reqHeaders,
      signal,
    });
  }

  /**
   * Best-effort debug capture that can never corrupt a request outcome.
   *
   * `captureHttpExchange` is invoked from inside `request`'s fetch try/catch,
   * immediately after a *successful* `fetch`. When the debug proxy is enabled
   * it does a synchronous capture-store write that can throw (e.g. SQLite
   * contention under the poller's sub-second cadence). An uncaught throw there
   * would be swallowed by the network-error `catch` and reported as
   * `statusCode: 0` — i.e. a POST that the server already accepted would look
   * like a failed send, and the best-effort delivery layer would retry it,
   * duplicating the reply. (This is the duplicate-DM-reply regression that
   * surfaced once debug mode was wired into the client.) Capture is telemetry,
   * so any failure here is logged and dropped.
   */
  private safeCapture(params: Parameters<typeof captureHttpExchange>[0]): void {
    try {
      captureHttpExchange(params);
    } catch (err) {
      this.logger?.debug("clawbits debug-capture failed (ignored)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {}
  ): Promise<T> {
    const { json, body, headers: extraHeaders = {}, challenge, auth, signal } = opts;

    if (path.includes("{") || path.includes("}")) {
      throw new ClawBitsError({
        statusCode: 0,
        detail: "unsubstituted placeholder in path",
        path,
      });
    }

    const reqHeaders: Record<string, string> = { ...extraHeaders };

    // Plugin version rides every request so the server can gate
    // wire-changed endpoints and emit telemetry about which versions
    // are live. The header is harmless on routes that don't check it.
    reqHeaders[PLUGIN_VERSION_HEADER] = PLUGIN_VERSION;

    if (auth !== false && this.apiKey) {
      reqHeaders["Authorization"] = `Bearer ${this.apiKey}`;
    }

    if (challenge) {
      reqHeaders["session_token"] = challenge.sessionToken;
      reqHeaders["challenge-RESPONSE"] = challenge.response;
    }

    // Correlate this call with the message round-trip's trace when the request
    // body carries one (an agent reply POST / streaming-draft create) or a
    // caller set the header explicitly. GET polls have no body and stay
    // untraced. The id rides the wire header so the server stitches its
    // sync-leg span on, and is attached to the latency metric below.
    const traceId =
      (typeof extraHeaders["x-clawbits-trace-id"] === "string" &&
        extraHeaders["x-clawbits-trace-id"]) ||
      (json !== null &&
      typeof json === "object" &&
      typeof (json as Record<string, unknown>)["trace_id"] === "string"
        ? ((json as Record<string, unknown>)["trace_id"] as string)
        : undefined);
    if (traceId) reqHeaders["x-clawbits-trace-id"] = traceId;

    let reqBody: BodyInit | undefined;
    if (json !== undefined) {
      reqHeaders["Content-Type"] = "application/json";
      reqBody = JSON.stringify(json);
    } else if (body !== undefined) {
      // Uint8Array is a valid fetch body at runtime but newer TS lib.dom
      // typings exclude it from BodyInit; the cast is safe.
      reqBody = body instanceof Uint8Array ? (body as unknown as BodyInit) : body;
    }

    const url = `${this.baseUrl}${path}`;
    const start = Date.now();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: reqHeaders,
        body: reqBody,
        ...(signal ? { signal } : {}),
      });
      // Debug-proxy capture is a no-op unless ``DEBUG_PROXY_*`` env vars
      // enable a session. The SDK clones the response before reading the
      // body and redacts ``Authorization`` headers, so this is safe to
      // leave wired in production. Note: only string/Buffer request
      // bodies are persisted — FormData/Blob/ReadableStream uploads
      // (none today) would appear as ``null`` in capture dumps. Routed
      // through ``safeCapture`` so a capture-store error can't be mistaken
      // for a failed request (which would retry and duplicate this POST).
      this.safeCapture({
        url,
        method: method.toUpperCase(),
        requestHeaders: reqHeaders,
        requestBody: reqBody ?? null,
        response,
        transport: "http",
        meta: { subsystem: "clawbits-fetch", path },
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      // Record the failure under the same capture seam so a debug
      // session sees network errors next to their succeeded peers.
      // The Response constructor rejects status < 200, so synthesise a
      // 599 ("network connect timeout error" convention). ``statusText``
      // must conform to HTTP reason-phrase (no CR/LF/control chars), so
      // we strip them — full error detail still lives in ``meta.error``.
      // ``onRequestMetric`` separately records statusCode: 0; the two
      // views deliberately disagree because capture needs a valid
      // Response to round-trip through the SDK's ``response.clone()``.
      const errMessage = err instanceof Error ? err.message : String(err);
      const errStatusText = errMessage.replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ").slice(0, 200);
      this.safeCapture({
        url,
        method: method.toUpperCase(),
        requestHeaders: reqHeaders,
        requestBody: reqBody ?? null,
        response: new Response(null, {
          status: 599,
          statusText: errStatusText,
        }),
        transport: "http",
        meta: {
          subsystem: "clawbits-fetch",
          path,
          errorType: "fetch-failed",
          error: errMessage,
        },
      });
      this.onRequestMetric?.({
        method,
        path,
        statusCode: 0,
        durationMs,
        ok: false,
        errorType: "network",
        timestamp: Date.now(),
        ...(traceId ? { traceId } : {}),
      });
      const baseMessage = err instanceof Error ? err.message : String(err);
      const cause =
        err &&
        typeof err === "object" &&
        "cause" in err &&
        (err as { cause?: unknown }).cause !== undefined
          ? (err as { cause?: unknown }).cause
          : undefined;
      const causeMessage =
        cause instanceof Error
          ? cause.message
          : cause !== undefined
            ? String(cause)
            : undefined;
      const details = [
        `network error calling ${method.toUpperCase()} ${url}`,
        baseMessage,
        causeMessage && causeMessage !== baseMessage ? `cause: ${causeMessage}` : undefined,
        this.baseUrl.includes("localhost") || this.baseUrl.includes("127.0.0.1")
          ? "hint: verify the Clawbits API is running and reachable from this machine/environment"
          : "hint: verify the Clawbits API URL, DNS, TLS certificate, and network reachability",
      ].filter(Boolean);
      throw new ClawBitsError({
        statusCode: 0,
        detail: details.join("; "),
        path,
      });
    }

    const durationMs = Date.now() - start;
    this.logger?.debug("clawbits request", {
      method,
      path,
      status: response.status,
      durationMs,
    });
    this.onRequestMetric?.({
      method,
      path,
      statusCode: response.status,
      durationMs,
      ok: response.ok,
      ...(response.ok ? {} : { errorType: "http" as const }),
      timestamp: Date.now(),
      ...(traceId ? { traceId } : {}),
    });

    if (response.ok) {
      const text = await response.text();
      return (text ? JSON.parse(text) : {}) as T;
    }

    const errorText = await response.text();
    let detail: unknown;
    try {
      detail = JSON.parse(errorText);
    } catch {
      detail = errorText;
    }

    throw new ClawBitsError({
      statusCode: response.status,
      detail: formatDetail(detail),
      path,
    });
  }
}

/**
 * Issue a client request bounded by `timeoutMs` AND a parent abort signal.
 *
 * The timer is always cleared in `finally`, so success or failure leaves no
 * lingering timer, and the parent listener is always removed. `label` only
 * shapes the timeout message — keep it caller-specific so a stuck loop is
 * identifiable from the error alone.
 */
export async function timedRequest<T>(
  client: ClawBitsClient,
  label: string,
  method: string,
  path: string,
  opts: { json?: unknown; timeoutMs: number; parent?: AbortSignal },
): Promise<T> {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(opts.parent?.reason);
  const timer = setTimeout(
    () => ctrl.abort(new Error(`${label} timed out after ${String(opts.timeoutMs)}ms`)),
    opts.timeoutMs,
  );
  if (opts.parent) {
    if (opts.parent.aborted) ctrl.abort(opts.parent.reason);
    else opts.parent.addEventListener("abort", onParentAbort, { once: true });
  }
  try {
    return await client.request<T>(method, path, {
      ...(opts.json !== undefined ? { json: opts.json } : {}),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
    opts.parent?.removeEventListener("abort", onParentAbort);
  }
}


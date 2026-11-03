export interface CapturedHttpExchange {
  url: string;
  method: string;
  requestHeaders?: Headers | Record<string, string> | undefined;
  requestBody?: RequestInit["body"];
  response: Response;
  transport?: "http" | "sse";
  flowId?: string;
  meta?: Record<string, unknown>;
}

export const capturedHttpExchanges: CapturedHttpExchange[] = [];

// Test seam: when set, `captureHttpExchangeAsync` rejects instead of recording —
// used to prove a capture-store failure can't corrupt the surrounding request.
let captureThrows: Error | null = null;

export function __setCaptureThrows(err: Error | null): void {
  captureThrows = err;
}

export async function captureHttpExchangeAsync(params: CapturedHttpExchange): Promise<void> {
  if (captureThrows) throw captureThrows;
  capturedHttpExchanges.push(params);
}

export function resetCapturedHttpExchanges(): void {
  capturedHttpExchanges.length = 0;
  captureThrows = null;
}

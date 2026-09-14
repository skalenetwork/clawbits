import { fetch } from "expo/fetch";
import { apiUrl, ApiError, receiveSession } from "./api";
import type { ChatEvent } from "./models";

export async function stream(
  path: string,
  token: string,
  signal: AbortSignal,
  onOpen: () => void,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
      },
      signal: AbortSignal.any([signal, controller.signal]),
    });
    await receiveSession(response.headers, token);
    if (!response.ok)
      throw new ApiError(response.status, "Live connection unavailable");
    if (!response.body) throw new Error("Missing event stream");
    onOpen();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), 45_000);
        buffer += decoder.decode(value, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) onEvent(JSON.parse(data) as ChatEvent);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

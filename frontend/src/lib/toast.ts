import {toast} from "sonner";

export {toast};

// Backend errors are thrown from fetch helpers as `new Error(await res.text())`,
// so `err.message` is usually the JSON body from our FastAPI handler:
//   { error: true, status_code: N, detail: string | ValidationError[], path: "..." }
// This helper digs the human-readable `detail` out of that shape so toasts
// don't display raw JSON.
export function errMsg(err: unknown, fallback = "Something went wrong"): string {
    const raw =
        err instanceof Error ? err.message :
        typeof err === "string" ? err :
        "";
    if (!raw) return fallback;

    const parsed = tryParseJson(raw);
    if (parsed !== null) {
        const detail = (parsed as {detail?: unknown}).detail;
        if (typeof detail === "string" && detail.length > 0) return detail;
        if (Array.isArray(detail) && detail.length > 0) {
            const first = detail[0] as {msg?: unknown; loc?: unknown};
            if (typeof first.msg === "string") {
                const field = Array.isArray(first.loc) && first.loc.length > 1
                    ? String(first.loc[first.loc.length - 1])
                    : null;
                return field ? `${field}: ${first.msg}` : first.msg;
            }
        }
    }

    // Not JSON, or no detail — return the raw message if it looks user-safe,
    // otherwise the fallback.
    return raw.startsWith("{") ? fallback : raw;
}

function tryParseJson(s: string): unknown {
    try { return JSON.parse(s); } catch { return null; }
}

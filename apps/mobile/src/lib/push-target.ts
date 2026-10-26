/** Where a tapped push leads, read with nothing native so it tests on its own. */
import type { QueryClient, QueryFunction, QueryKey } from "@tanstack/react-query";

/** A push's chat, and for a turn ping the game to open there. */
export interface PushTarget {
  channelId: string;
  widgetId?: string;
}

/** What a target is read from in a delivered notification: expo's `data`, which for a remote push on iOS is the
 *  push's `body` dictionary, and the trigger, whose `payload` is the whole push. */
export interface PushRequest {
  content: { data?: Record<string, unknown> | null };
  trigger?: unknown;
}

/** The chat (and game) a push names, or null. The server sends its keys under `body`, which expo hands over as
 *  `data`, and copies them to the top level: an expo that fills `data` some other way still finds them on the
 *  trigger's payload. Both keys come from the same place. */
export function pushTarget(request: PushRequest): PushTarget | null {
  for (const source of [request.content.data, payloadOf(request.trigger)]) {
    const channelId = source?.channelId;
    if (typeof channelId !== "string" || !channelId) continue;
    const widgetId = source?.widgetId;
    return typeof widgetId === "string" && widgetId ? { channelId, widgetId } : { channelId };
  }
  return null;
}

/** The game a turn ping's tap puts in its chat's bar, as the web's `linkedGameOf`: the chat's running game, which is
 *  the one waiting now, even when an older ping names one that has since ended; the pinged game only while none
 *  runs, to show how it ended. Shown over the bar's own game either way, so a game a message tap left there can't
 *  hide it. */
export function pingedGameOf(pinged: string, active: string | null): string {
  return active ?? pinged;
}

/** What `queryKey` answers now, for a tap that waits on it: asked even while the cache holds a fresh answer, which can
 *  predate the push, and while the device thinks it's offline, with no retry; what the cache holds if the ask fails.
 *  So the tap neither opens a stale answer nor stalls. */
export function askAfresh<T>(client: QueryClient, queryKey: QueryKey, queryFn: QueryFunction<T>): Promise<T | undefined> {
  return client
    .fetchQuery({ queryKey, queryFn, staleTime: 0, retry: false, networkMode: "always" })
    .catch(() => client.getQueryData<T>(queryKey));
}

function payloadOf(trigger: unknown): Record<string, unknown> | null {
  const payload: unknown =
    typeof trigger === "object" && trigger !== null && "payload" in trigger ? trigger.payload : null;
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
}

/** What tells one tap from another. iOS gives a push its collapse id as its identifier (`turn:{chat}` for a turn ping,
 *  the chat for a message), so every push for a chat shares one; the delivery date sets them apart, while the same tap,
 *  met both at launch and by the listener, keys alike. */
export function tapKey(response: { notification: { date: number; request: { identifier: string } } }): string {
  return `${response.notification.request.identifier}@${response.notification.date}`;
}

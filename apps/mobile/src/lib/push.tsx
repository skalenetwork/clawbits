import { useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router, usePathname } from "expo-router";
import { useEffect, useEffectEvent, useRef } from "react";
import { AppState } from "react-native";
import { showGame } from "@/components/widgets/game-bar-state";
import { api, request } from "./api";
import { activeGameOf } from "./data";
import { pingedGameOf, pushTarget, tapKey } from "./push-target";
import { useSession } from "./session";

export function PushNotifications() {
  const { session, selectOrg } = useSession();
  const client = useQueryClient();
  const pathname = usePathname();
  const token = session?.token;
  const handled = useRef<string | null>(null);
  const opened = useEffectEvent(
    async (response: Notifications.NotificationResponse | null) => {
      if (!response || !session || handled.current === tapKey(response))
        return;
      const target = pushTarget(response.notification.request);
      if (!target) return;
      const id = target.channelId;
      handled.current = tapKey(response);
      try {
        const channel = await api.channel(session.token, id);
        if (channel.org_id) await selectOrg(channel.org_id);
        // A turn ping opens the chat's game in its bar: the running one, else how the pinged one ended.
        if (target.widgetId) {
          const active = await activeGameOf(client, session.token, id);
          showGame(id, pingedGameOf(target.widgetId, active));
        }
        router.push({ pathname: "/chat/[id]", params: { id } });
        await Notifications.clearLastNotificationResponseAsync();
      } catch {
        handled.current = null;
      }
    },
  );

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const visible =
          AppState.currentState === "active" &&
          pathname === `/chat/${pushTarget(notification.request)?.channelId}`;
        return {
          shouldShowBanner: !visible,
          shouldShowList: !visible,
          shouldPlaySound: !visible,
          shouldSetBadge: false,
        };
      },
    });
  }, [pathname]);

  useEffect(() => {
    if (!token) return;
    let device: string | undefined;
    let active = true;
    const subscribe = (value: string) => {
      device = value;
      return request("/api/push/mobile/subscribe", token, { token: value });
    };
    const register = async () => {
      const { granted } = await Notifications.getPermissionsAsync();
      if (
        !(granted || (await Notifications.requestPermissionsAsync()).granted) ||
        !active
      )
        return;
      const result = await Notifications.getDevicePushTokenAsync();
      if (result.type === "ios" && active) await subscribe(String(result.data));
    };
    void register().catch(() => undefined);
    void Notifications.getLastNotificationResponseAsync().then(opened);
    const taps = Notifications.addNotificationResponseReceivedListener(opened);
    const tokens = Notifications.addPushTokenListener((value) => {
      if (value.type === "ios")
        void subscribe(String(value.data)).catch(() => undefined);
    });
    return () => {
      active = false;
      taps.remove();
      tokens.remove();
      if (device)
        void request("/api/push/mobile/unsubscribe", token, {
          token: device,
        }).catch(() => undefined);
    };
  }, [token]);
  return null;
}

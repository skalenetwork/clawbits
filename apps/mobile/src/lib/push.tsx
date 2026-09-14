import * as Notifications from "expo-notifications";
import { router, usePathname } from "expo-router";
import { useEffect, useEffectEvent, useRef } from "react";
import { AppState } from "react-native";
import { api, request } from "./api";
import { useSession } from "./session";

export function PushNotifications() {
  const { session, selectOrg } = useSession();
  const pathname = usePathname();
  const token = session?.token;
  const handled = useRef<string | null>(null);
  const opened = useEffectEvent(
    async (response: Notifications.NotificationResponse | null) => {
      if (
        !response ||
        !session ||
        handled.current === response.notification.request.identifier
      )
        return;
      const id: unknown = response.notification.request.content.data?.channelId;
      if (typeof id !== "string") return;
      handled.current = response.notification.request.identifier;
      try {
        const channel = await api.channel(session.token, id);
        if (channel.org_id) await selectOrg(channel.org_id);
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
          pathname === `/chat/${notification.request.content.data?.channelId}`;
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

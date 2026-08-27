import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { router } from 'expo-router';

import { subscribeMobilePush, unsubscribeMobilePush } from '@/lib/api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let registeredDeviceToken: string | null = null;

const TAP_MAX_AGE_MS = 60_000;

export async function registerPush(apiToken: string): Promise<void> {
  const current = await Notifications.getPermissionsAsync();
  const granted =
    current.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return;
  const push = await Notifications.getDevicePushTokenAsync();
  if (push.type !== 'ios') return;
  const deviceToken = String(push.data);
  await subscribeMobilePush(apiToken, deviceToken);
  registeredDeviceToken = deviceToken;
}

export async function unregisterPush(apiToken: string): Promise<void> {
  if (!registeredDeviceToken) return;
  const deviceToken = registeredDeviceToken;
  registeredDeviceToken = null;
  await unsubscribeMobilePush(apiToken, deviceToken).catch(() => {});
}

function routeToChannel(response: Notifications.NotificationResponse | null): void {
  const channelId = response?.notification.request.content.data?.channelId;
  if (typeof channelId !== 'string' || channelId.length === 0) return;
  router.push({ pathname: '/(tabs)/chats/[channelId]', params: { channelId } });
}

/** Route taps that launched the app (cold) or arrive in-flight (warm).
 *  The cold-launch response persists across launches, so stale taps are
 *  dropped by age rather than tracked state. */
export function usePushNavigation(): void {
  useEffect(() => {
    const fresh = (response: Notifications.NotificationResponse | null): boolean =>
      response != null && Date.now() - response.notification.date <= TAP_MAX_AGE_MS;

    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (fresh(response)) routeToChannel(response);
    });
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      routeToChannel(response);
    });
    return () => sub.remove();
  }, []);
}

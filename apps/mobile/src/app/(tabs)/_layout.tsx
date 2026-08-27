import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { DynamicColorIOS, PlatformColor, StyleSheet, View } from 'react-native';

import { useTotalUnread } from '@/hooks/use-channels';
import { NavigationRail } from '@/components/navigation-rail';
import { useIsLargeWindow } from '@/hooks/use-window-size-class';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import { useTabBarVisibility } from '@/providers/tab-bar-visibility';

const tintColor =
  process.env.EXPO_OS === 'ios'
    ? DynamicColorIOS({ light: '#111827', dark: '#f9fafb' })
    : PlatformColor('?attr/colorPrimary');

export default function TabsLayout() {
  const { hidden } = useTabBarVisibility();
  const isLarge = useIsLargeWindow();
  const { selectedOrg } = useSelectedOrg();
  const totalUnread = useTotalUnread(selectedOrg?.org_id ?? null);

  // At ≥600dp swap the bottom tab bar for an M3 navigation rail on the
  // left. NativeTabs still owns route state and per-tab screen
  // preservation — it just becomes ``hidden`` so its bottom bar
  // disappears, while the rail (a sibling) is the visible navigation
  // surface. Compact phones keep the native bottom tabs unchanged.
  const tabs = (
    <NativeTabs
      minimizeBehavior="never"
      tintColor={tintColor}
      hidden={isLarge || hidden}>
      <NativeTabs.Trigger name="home">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'circle.grid.2x2', selected: 'circle.grid.2x2.fill' }}
          md={{ default: 'apps', selected: 'apps' }}
        />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="chats">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'message', selected: 'message.fill' }}
          md={{ default: 'chat', selected: 'chat' }}
        />
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={totalUnread === 0}>
          {totalUnread > 99 ? '99+' : String(totalUnread)}
        </NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="search">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'magnifyingglass', selected: 'magnifyingglass' }}
          md={{ default: 'search', selected: 'search' }}
        />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'gearshape.2', selected: 'gearshape.2.fill' }}
          md={{ default: 'settings_suggest', selected: 'settings_suggest' }}
        />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );

  if (!isLarge) return tabs;

  return (
    <View style={styles.row}>
      <NavigationRail />
      <View style={styles.flex}>{tabs}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flex: 1, flexDirection: 'row' },
});

import Stack from 'expo-router/stack';

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerTransparent: true,
        headerTitleAlign: 'left',
        headerShadowVisible: false,
        scrollEdgeEffects: { top: 'soft' },
      }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="profile" options={{ title: 'Profile' }} />
      <Stack.Screen name="appearance" options={{ title: 'Appearance' }} />
      <Stack.Screen name="workspaces/index" options={{ title: 'Workspaces' }} />
      <Stack.Screen name="workspaces/[orgId]" options={{ title: 'Workspace' }} />
    </Stack>
  );
}

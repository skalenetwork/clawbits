import Stack from 'expo-router/stack';

export default function HomeLayout() {
  return (
    <Stack
      screenOptions={{
        headerTransparent: true,
        headerTitleAlign: 'left',
        headerShadowVisible: false,
        scrollEdgeEffects: { top: 'soft' },
      }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}

import Stack from 'expo-router/stack';

export default function SearchLayout() {
  // Matches the other tab stacks (Home/Chats): a transparent native header
  // with a left-aligned title, content scrolling under it.
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

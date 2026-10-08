import { Stack } from "expo-router";
import { color, styles } from "@/components/ui";

export default function ChatsLayout() {
  return (
    <Stack
      screenOptions={{
        headerTintColor: color.header,
        headerTitleStyle: { color: color.header },
        headerLargeTitleStyle: { color: color.header },
        contentStyle: styles.screen,
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: "Chats", headerLargeTitle: true }}
      />
    </Stack>
  );
}

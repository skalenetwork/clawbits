import { Stack } from "expo-router";
import { color, styles } from "@/components/ui";

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerTintColor: color.header,
        headerTitleStyle: { color: color.header },
        headerLargeTitleStyle: { color: color.header },
        contentStyle: styles.grouped,
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: "Settings", headerLargeTitle: true }}
      />
    </Stack>
  );
}

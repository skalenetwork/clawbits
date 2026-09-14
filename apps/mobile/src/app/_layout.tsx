import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SessionProvider, useSession } from "@/lib/session";
import { DataProvider } from "@/lib/data";
import { Empty, styles } from "@/components/ui";
import { View } from "react-native";
import { PushNotifications } from "@/lib/push";

export default function RootLayout() {
  return (
    <KeyboardProvider>
      <SessionProvider>
        <StatusBar style="auto" />
        <Root />
      </SessionProvider>
    </KeyboardProvider>
  );
}

function Root() {
  const { session, loading } = useSession();
  if (loading)
    return (
      <View style={styles.screen}>
        <Empty title="" loading />
      </View>
    );
  const stack = (
    <Stack
      screenOptions={{
        headerBackButtonDisplayMode: "minimal",
        contentStyle: styles.screen,
      }}
    >
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!!session}>
        <Stack.Screen
          name="index"
          options={{ title: "Chats", headerLargeTitle: true }}
        />
        <Stack.Screen name="chat/[id]" options={{ title: "" }} />
        <Stack.Screen
          name="new"
          options={{
            title: "New Message",
            presentation: "formSheet",
            sheetGrabberVisible: true,
            sheetAllowedDetents: [0.75, 1],
          }}
        />
      </Stack.Protected>
    </Stack>
  );
  return session ? (
    <DataProvider key={session.user.id}>
      <PushNotifications />
      {stack}
    </DataProvider>
  ) : (
    stack
  );
}

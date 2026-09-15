import { Stack, ThemeProvider, DarkTheme, DefaultTheme } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SessionProvider, useSession } from "@/lib/session";
import { DataProvider } from "@/lib/data";
import { color, Empty, styles } from "@/components/ui";
import { useColorScheme, View } from "react-native";
import { PushNotifications } from "@/lib/push";

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
      <KeyboardProvider>
        <SessionProvider>
          <StatusBar style="auto" />
          <Root />
        </SessionProvider>
      </KeyboardProvider>
    </ThemeProvider>
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
        headerTintColor: color.header,
        headerTitleStyle: { color: color.header },
        headerLargeTitleStyle: { color: color.header },
        contentStyle: styles.screen,
      }}
    >
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!!session && !session.org}>
        <Stack.Screen
          name="select-org"
          options={{ title: "Workspaces", headerLargeTitle: true }}
        />
      </Stack.Protected>
      <Stack.Protected guard={!!session && !!session.org}>
        <Stack.Screen
          name="index"
          options={{ title: "Chats", headerLargeTitle: true }}
        />
        <Stack.Screen name="chat/[id]" options={{ headerShown: false }} />
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

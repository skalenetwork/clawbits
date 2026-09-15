import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import * as WebBrowser from "expo-web-browser";
import { apiUrl, request } from "@/lib/api";
import type { User } from "@/lib/models";
import { useSession } from "@/lib/session";
import { color, GlassButton, GlassField, styles } from "@/components/ui";

const providers = [
  ["google", "Google", require("../../assets/images/google.png")],
  ["github", "GitHub", require("../../assets/images/github.png")],
] as const;

export default function SignIn() {
  const dark = useColorScheme() === "dark";
  const { signIn, error } = useSession();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      Alert.alert(
        "Could not sign in",
        cause instanceof Error ? cause.message : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const submit = () =>
    perform(async () => {
      if (!sent) {
        await request("/api/auth/magic/send", undefined, {
          email: email.trim(),
        });
        setSent(true);
        return;
      }
      const user = await request<User>("/api/auth/magic/verify", undefined, {
        email: email.trim(),
        code,
      });
      if (!user.token) throw new Error("The server did not return a session.");
      await signIn(user.token);
    });
  const social = (provider: "google" | "github") =>
    perform(async () => {
      const result = await WebBrowser.openAuthSessionAsync(
        `${apiUrl}/api/auth/social/${provider}/start?bridge=deeplink`,
        "clawbits://oauth-callback",
      );
      if (result.type !== "success") return;
      const url = new URL(result.url);
      const token = url.searchParams.get("token");
      if (
        url.protocol !== "clawbits:" ||
        url.hostname !== "oauth-callback" ||
        !token
      )
        throw new Error("Invalid sign-in response.");
      await signIn(token);
    });
  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1, justifyContent: "center", padding: 28, gap: 18 }}
      >
        <Image
          source={require("../../assets/images/clawbits-long-current.svg")}
          accessibilityLabel="Clawbits"
          style={{ width: 168, height: 28, alignSelf: "center", marginBottom: 8 }}
          contentFit="contain"
          tintColor={dark ? "#f7f5f1" : "#000000"}
        />
        {error && <Text style={styles.error}>{error}</Text>}
        <GlassField
          placeholder="Email"
          onChangeText={setEmail}
          disabled={sent || busy}
          keyboard="email-address"
          contentType="emailAddress"
          submit="continue"
          onSubmit={() => {
            if (!sent && email.trim()) void submit();
          }}
        />
        {sent && (
          <GlassField
            placeholder="Code from your email"
            onChangeText={setCode}
            autoFocus
            disabled={busy}
            keyboard="numeric"
            contentType="oneTimeCode"
            submit="go"
            onSubmit={() => {
              if (code) void submit();
            }}
          />
        )}
        <GlassButton
          label={busy ? "Please wait…" : sent ? "Sign In" : "Continue with Email"}
          prominent
          disabled={busy || !email.trim() || (sent && !code)}
          onPress={() => {
            void submit();
          }}
        />
        {sent ? (
          <GlassButton
            label="Use another email"
            disabled={busy}
            onPress={() => {
              setSent(false);
              setCode("");
            }}
          />
        ) : (
          <View style={{ gap: 12 }}>
            {providers.map(([provider, label, icon]) => (
              <GlassButton
                key={provider}
                label={`Continue with ${label}`}
                icon={icon}
                iconTint={provider === "github" ? color.text : undefined}
                disabled={busy}
                onPress={() => {
                  void social(provider);
                }}
              />
            ))}
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import * as WebBrowser from "expo-web-browser";
import { apiUrl, request } from "@/lib/api";
import type { User } from "@/lib/models";
import { useSession } from "@/lib/session";
import { color, GlassButton, styles } from "@/components/ui";

const providers = [
  ["google", "Google"],
  ["github", "GitHub"],
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
          source={require("../../assets/images/clawbits-long.svg")}
          accessibilityLabel="Clawbits"
          style={{ width: "100%", height: 56, marginBottom: 16 }}
          contentFit="contain"
          tintColor={dark ? "#e8e3da" : "#1e1e1e"}
        />
        {error && <Text style={styles.error}>{error}</Text>}
        <TextInput
          accessibilityLabel="Email"
          placeholder="Email"
          placeholderTextColor={color.muted}
          style={styles.input}
          autoCapitalize="none"
          keyboardType="email-address"
          textContentType="emailAddress"
          value={email}
          editable={!sent && !busy}
          onChangeText={setEmail}
        />
        {sent && (
          <TextInput
            accessibilityLabel="Verification code"
            placeholder="Code from your email"
            placeholderTextColor={color.muted}
            style={styles.input}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoFocus
            value={code}
            onChangeText={setCode}
            editable={!busy}
          />
        )}
        <GlassButton
          label={busy ? "Please wait…" : sent ? "Sign In" : "Continue with Email"}
          prominent
          disabled={busy || !email.trim() || (sent && !code)}
          onPress={() => { void submit(); }}
        />
        {sent ? (
          <GlassButton
            label="Use another email"
            disabled={busy}
            onPress={() => { setSent(false); setCode(""); }}
          />
        ) : (
          <View style={{ gap: 12 }}>
            {providers.map(([provider, label]) => (
              <GlassButton
                key={provider}
                label={`Continue with ${label}`}
                disabled={busy}
                onPress={() => { void social(provider); }}
              />
            ))}
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

import { Image } from "expo-image";
import { Host } from "@expo/ui";
import { Button, Text as NativeText, type ButtonProps } from "@expo/ui/swift-ui";
import { accessibilityLabel, buttonBorderShape, buttonStyle, controlSize, disabled as disabledModifier, font, foregroundStyle, frame, labelStyle, tint } from "@expo/ui/swift-ui/modifiers";
import {
  ActivityIndicator,
  DynamicColorIOS,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { Avatar } from "@/lib/models";

export const color = {
  background: DynamicColorIOS({ light: "#ffffff", dark: "#090909" }),
  secondary: DynamicColorIOS({ light: "#f6f5f4", dark: "#161513" }),
  text: DynamicColorIOS({ light: "#1e1e1e", dark: "#e8e3da" }),
  muted: DynamicColorIOS({ light: "#67635b", dark: "#87837c" }),
  line: DynamicColorIOS({ light: "#c5c2bd", dark: "#2e2c27" }),
  primary: DynamicColorIOS({ light: "#2e2e2e", dark: "#d9d7c9" }),
  onPrimary: DynamicColorIOS({ light: "#f8f7f1", dark: "#1c1c1c" }),
  red: DynamicColorIOS({ light: "#b73416", dark: "#ef643b" }),
};

export function GlassButton({ label, onPress, disabled = false, prominent = false }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  prominent?: boolean;
}) {
  return (
    <Host style={{ alignSelf: "stretch", height: 56 }}>
      <Button onPress={onPress} modifiers={[
        buttonStyle(prominent ? "glassProminent" : "glass"),
        buttonBorderShape("capsule"),
        controlSize("large"),
        tint(color.primary),
        disabledModifier(disabled),
      ]}>
        <NativeText modifiers={[
          font({ size: 17, weight: "semibold" }),
          foregroundStyle(prominent ? color.onPrimary : color.text),
          frame({ maxWidth: Infinity, minHeight: 24 }),
        ]}>{label}</NativeText>
      </Button>
    </Host>
  );
}

export function IconButton({
  name,
  label,
  onPress,
  disabled = false,
}: {
  name: ButtonProps["systemImage"];
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Host style={{ width: 44, height: 44 }}>
      <Button label={label} systemImage={name} onPress={onPress} modifiers={[
        buttonStyle("glass"),
        buttonBorderShape("circle"),
        controlSize("large"),
        labelStyle("iconOnly"),
        tint(color.primary),
        accessibilityLabel(label),
        disabledModifier(disabled),
      ]} />
    </Host>
  );
}

export function AvatarView({
  avatar,
  name,
}: {
  avatar?: Avatar | null;
  name: string;
}) {
  return (
    <View style={styles.avatar}>
      {avatar?.url ? (
        <Image
          source={avatar.url}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      ) : (
        <Text style={styles.initial}>{name.slice(0, 1).toUpperCase()}</Text>
      )}
    </View>
  );
}

export function Empty({
  title,
  detail,
  loading,
  onRetry,
}: {
  title: string;
  detail?: string;
  loading?: boolean;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.empty}>
      {loading ? (
        <ActivityIndicator />
      ) : (
        <>
          <Text style={styles.heading}>{title}</Text>
          {detail && <Text style={styles.detail}>{detail}</Text>}
          {onRetry && (
            <GlassButton label="Try again" onPress={onRetry} />
          )}
        </>
      )}
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.background },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    minHeight: 76,
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.secondary,
  },
  initial: { fontSize: 22, fontWeight: "600", color: color.muted },
  name: { fontSize: 17, fontWeight: "600", color: color.text },
  detail: { fontSize: 15, color: color.muted, textAlign: "center" },
  preview: { fontSize: 15, color: color.muted, marginTop: 4 },
  heading: { fontSize: 22, fontWeight: "600", color: color.text },
  empty: {
    flex: 1,
    padding: 32,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.line,
    marginLeft: 82,
  },
  input: {
    fontSize: 17,
    color: color.text,
    backgroundColor: color.secondary,
    borderRadius: 24,
    padding: 16,
  },
  error: { fontSize: 14, color: color.red, padding: 12, textAlign: "center" },
});

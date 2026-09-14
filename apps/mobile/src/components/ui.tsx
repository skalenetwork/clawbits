import { Image } from "expo-image";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import {
  ActivityIndicator,
  PlatformColor,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { Avatar } from "@/lib/models";

export const color = {
  background: PlatformColor("systemBackground"),
  secondary: PlatformColor("secondarySystemBackground"),
  text: PlatformColor("label"),
  muted: PlatformColor("secondaryLabel"),
  line: PlatformColor("separator"),
  blue: PlatformColor("systemBlue"),
  red: PlatformColor("systemRed"),
};

export function IconButton({
  name,
  label,
  onPress,
  disabled = false,
}: {
  name: SymbolViewProps["name"];
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.35 : pressed ? 0.5 : 1,
      })}
    >
      <SymbolView
        name={name}
        tintColor={color.blue}
        style={{ width: 22, height: 22 }}
      />
    </Pressable>
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
            <Pressable
              onPress={onRetry}
              accessibilityRole="button"
              style={styles.retry}
            >
              <Text style={styles.link}>Try again</Text>
            </Pressable>
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
  link: { fontSize: 17, color: color.blue },
  retry: { padding: 12 },
  input: {
    fontSize: 17,
    color: color.text,
    backgroundColor: color.secondary,
    borderRadius: 12,
    padding: 16,
  },
  error: { fontSize: 14, color: color.red, padding: 12, textAlign: "center" },
});

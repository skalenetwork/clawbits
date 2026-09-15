import { Image } from "expo-image";
import { Host } from "@expo/ui";
import {
  Button,
  GlassEffectContainer,
  HStack,
  Text as NativeText,
  TextField,
  VStack,
  type ButtonProps,
  type TextFieldRef,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  autocorrectionDisabled,
  buttonBorderShape,
  buttonStyle,
  controlSize,
  disabled as disabledModifier,
  font,
  foregroundStyle,
  frame,
  glassEffect,
  keyboardType,
  labelStyle,
  lineLimit,
  onSubmit as onSubmitModifier,
  padding,
  submitLabel,
  textContentType,
  textFieldStyle,
  textInputAutocapitalization,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useImperativeHandle, useRef, type Ref } from "react";
import {
  ActivityIndicator,
  PlatformColor,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { Avatar } from "@/lib/models";

export const color = {
  background: PlatformColor("systemBackground"),
  secondary: PlatformColor("tertiarySystemFill"),
  text: PlatformColor("label"),
  muted: PlatformColor("secondaryLabel"),
  line: PlatformColor("separator"),
  primary: PlatformColor("systemBlue"),
  onPrimary: "#ffffff",
  red: PlatformColor("systemRed"),
};

export function GlassButton({
  label,
  onPress,
  disabled = false,
  prominent = false,
  icon,
  iconTint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  prominent?: boolean;
  icon?: number;
  iconTint?: string;
}) {
  return (
    <View style={{ alignSelf: "stretch", height: 56 }}>
      <Host style={StyleSheet.absoluteFill}>
        <Button
          onPress={onPress}
          modifiers={[
            buttonStyle(prominent ? "glassProminent" : "glass"),
            buttonBorderShape("capsule"),
            controlSize("large"),
            ...(prominent ? [tint(color.text)] : []),
            disabledModifier(disabled),
          ]}
        >
          <NativeText
            modifiers={[
              font({ textStyle: "body", weight: "regular" }),
              foregroundStyle(prominent ? color.background : color.text),
              frame({ maxWidth: Infinity, minHeight: 24 }),
            ]}
          >
            {label}
          </NativeText>
        </Button>
      </Host>
      {icon != null && (
        <Image
          source={icon}
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={styles.buttonIcon}
          contentFit="contain"
          tintColor={iconTint}
          pointerEvents="none"
        />
      )}
    </View>
  );
}

export function IconButton({
  name,
  label,
  onPress,
  disabled = false,
  prominent = false,
}: {
  name: ButtonProps["systemImage"];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  prominent?: boolean;
}) {
  return (
    <Host matchContents>
      <Button
        label={label}
        systemImage={name}
        onPress={onPress}
        modifiers={[
          buttonStyle("plain"),
          buttonBorderShape("circle"),
          controlSize("large"),
          labelStyle("iconOnly"),
          frame({ width: 32, height: 32 }),
          ...(prominent ? [tint(color.text)] : []),
          accessibilityLabel(label),
          disabledModifier(disabled),
        ]}
      />
    </Host>
  );
}

export function GlassField({
  placeholder,
  onChangeText,
  autoFocus = false,
  disabled = false,
  keyboard,
  contentType,
  submit,
  onSubmit,
}: {
  placeholder: string;
  onChangeText: (text: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  keyboard?: "email-address" | "numeric";
  contentType?: "emailAddress" | "oneTimeCode";
  submit?: "continue" | "go" | "send";
  onSubmit?: () => void;
}) {
  return (
    <Host style={{ alignSelf: "stretch", height: 56 }}>
      <VStack
        modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]}
      >
        <TextField
          placeholder={placeholder}
          autoFocus={autoFocus}
          onTextChange={onChangeText}
          modifiers={[
            accessibilityLabel(placeholder),
            textFieldStyle("plain"),
            font({ textStyle: "body", weight: "regular" }),
            padding({ horizontal: 18 }),
            frame({ maxWidth: Infinity, maxHeight: Infinity }),
            glassEffect({
              glass: { variant: "regular", interactive: true },
              shape: "capsule",
            }),
            textInputAutocapitalization("never"),
            autocorrectionDisabled(true),
            ...(keyboard ? [keyboardType(keyboard)] : []),
            ...(contentType ? [textContentType(contentType)] : []),
            ...(submit ? [submitLabel(submit)] : []),
            ...(onSubmit ? [onSubmitModifier(onSubmit)] : []),
            disabledModifier(disabled),
          ]}
        />
      </VStack>
    </Host>
  );
}

export type GlassComposerHandle = {
  setText: (text: string) => Promise<void>;
  clear: () => Promise<void>;
};

export function GlassComposer({
  composerRef,
  onChangeText,
  onSend,
  sendDisabled,
  inputDisabled = false,
}: {
  composerRef?: Ref<GlassComposerHandle>;
  onChangeText: (text: string) => void;
  onSend: () => void;
  sendDisabled: boolean;
  inputDisabled?: boolean;
}) {
  const field = useRef<TextFieldRef>(null);
  useImperativeHandle(composerRef, () => ({
    setText: (text: string) => field.current?.setText(text) ?? Promise.resolve(),
    clear: () => field.current?.clear() ?? Promise.resolve(),
  }));
  return (
    <Host
      matchContents={{ vertical: true }}
      style={{ alignSelf: "stretch" }}
      seedColor={color.text}
    >
      <GlassEffectContainer spacing={10}>
        <HStack
          spacing={8}
          alignment="bottom"
          modifiers={[padding({ horizontal: 10, vertical: 6 })]}
        >
          <Button
            label="Attachments, coming later"
            systemImage="plus"
            onPress={() => undefined}
            modifiers={[
              buttonStyle("glass"),
              buttonBorderShape("circle"),
              controlSize("large"),
              labelStyle("iconOnly"),
              accessibilityLabel("Attachments, coming later"),
              disabledModifier(true),
            ]}
          />
          <TextField
            ref={field}
            placeholder="Message"
            axis="vertical"
            maxLength={4000}
            onTextChange={onChangeText}
            modifiers={[
              accessibilityLabel("Message"),
              glassEffect({
                glass: { variant: "regular", interactive: true },
                shape: "capsule",
              }),
              frame({ maxWidth: Infinity, minHeight: 36 }),
              padding({ horizontal: 14, vertical: 8 }),
              font({ textStyle: "body" }),
              lineLimit({ min: 1, max: 5 }),
              submitLabel("send"),
              onSubmitModifier(onSend),
              disabledModifier(inputDisabled),
            ]}
          />
          <Button
            label="Send message"
            systemImage="arrow.up"
            onPress={onSend}
            modifiers={[
              buttonStyle("glassProminent"),
              buttonBorderShape("circle"),
              controlSize("large"),
              labelStyle("iconOnly"),
              tint(color.text),
              accessibilityLabel("Send message"),
              disabledModifier(sendDisabled),
            ]}
          />
        </HStack>
      </GlassEffectContainer>
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
          {onRetry && <GlassButton label="Try again" onPress={onRetry} />}
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
  name: { fontSize: 17, fontWeight: "400", color: color.text },
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
  error: { fontSize: 14, color: color.red, padding: 12, textAlign: "center" },
  buttonIcon: {
    position: "absolute",
    left: 22,
    top: 19,
    width: 18,
    height: 18,
  },
});

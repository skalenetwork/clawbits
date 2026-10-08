import { Image } from "expo-image";
import { GlassView } from "expo-glass-effect";
import { SymbolView } from "expo-symbols";
import { Host } from "@expo/ui";
import {
  Button,
  Text as NativeText,
  TextField,
  VStack,
  type ButtonProps,
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
  onSubmit as onSubmitModifier,
  padding,
  submitLabel,
  textContentType,
  textFieldStyle,
  textInputAutocapitalization,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import {
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  GLASS_BLUR_PAD,
  GLASS_BLUR_RADIUS,
  useGlassAvatar,
} from "@/lib/glassAvatar";
import { KeyboardController } from "react-native-keyboard-controller";
import {
  ActivityIndicator,
  DynamicColorIOS,
  PlatformColor,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
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
  header: DynamicColorIOS({ light: "#000000", dark: "#ffffff" }),
};

export function useHostColorScheme(): "light" | "dark" | undefined {
  const scheme = useColorScheme();
  return scheme === "dark" || scheme === "light" ? scheme : undefined;
}

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
  const colorScheme = useHostColorScheme();
  return (
    <View style={{ alignSelf: "stretch", height: 56 }}>
      <Host colorScheme={colorScheme} style={StyleSheet.absoluteFill}>
        <Button
          onPress={onPress}
          modifiers={[
            buttonStyle(prominent ? "glassProminent" : "glass"),
            buttonBorderShape("capsule"),
            controlSize("large"),
            ...(prominent ? [tint(color.header)] : []),
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
  const colorScheme = useHostColorScheme();
  return (
    <Host matchContents colorScheme={colorScheme}>
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
          foregroundStyle(color.header),
          ...(prominent ? [tint(color.header)] : []),
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
  const colorScheme = useHostColorScheme();
  return (
    <Host colorScheme={colorScheme} style={{ alignSelf: "stretch", height: 56 }}>
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

type ComposerInput = {
  focus: () => void;
};

function keepComposerFocus(input: { current: ComposerInput | null }) {
  KeyboardController.setFocusTo("current");
  input.current?.focus();
}

export type ComposerAttachment = {
  id: string;
  name: string;
  status: "uploading" | "uploaded" | "failed";
};

export function GlassComposer({
  composerRef,
  onSend,
  onPlus,
  onRemoveAttachment,
  attachments = [],
  sendDisabled,
  placeholder = "Message",
}: {
  composerRef?: Ref<GlassComposerHandle>;
  onSend: (text: string) => void;
  onPlus: () => void;
  onRemoveAttachment?: (id: string) => void;
  attachments?: ComposerAttachment[];
  sendDisabled: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const hasFile = attachments.some((file) => file.status === "uploaded");
  const sendOn = !sendDisabled && (!!value.trim() || hasFile);
  const input = useRef<ComposerInput>(null);
  const keepFocus = () => {
    keepComposerFocus(input);
  };
  useImperativeHandle(composerRef, () => ({
    setText: (text: string) => {
      setValue(text);
      return Promise.resolve();
    },
    clear: () => {
      setValue("");
      keepFocus();
      return Promise.resolve();
    },
  }));
  const submit = () => {
    const message = value.trim();
    if ((!message && !hasFile) || sendDisabled) return;
    setValue("");
    keepFocus();
    onSend(message);
  };
  return (
    <View style={composer.column}>
      {attachments.length > 0 ? (
        <View style={composer.files}>
          {attachments.map((file) => (
            <Pressable
              key={file.id}
              accessibilityLabel={`Remove ${file.name}`}
              onPress={() => onRemoveAttachment?.(file.id)}
              style={composer.file}
            >
              <Text numberOfLines={1} style={composer.fileName}>
                {file.status === "uploading"
                  ? `Uploading ${file.name}`
                  : file.status === "failed"
                    ? `Failed ${file.name}`
                    : file.name}
              </Text>
              <SymbolView name="xmark" size={12} weight="bold" tintColor={color.header} />
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={composer.row}>
      <Pressable
        accessibilityLabel="Attachments"
        accessibilityRole="button"
        hitSlop={6}
        onPress={onPlus}
        style={composer.plus}
      >
        <GlassView
          glassEffectStyle="regular"
          isInteractive
          style={composer.plusGlass}
        />
        <SymbolView
          name="plus"
          size={22}
          weight="medium"
          tintColor={color.header}
        />
      </Pressable>
      <GlassView
        glassEffectStyle="regular"
        isInteractive={false}
        style={composer.field}
      >
        <TextInput
          ref={input as never}
          accessibilityLabel="Message"
          placeholder={placeholder}
          placeholderTextColor="#8E8E93"
          onChangeText={setValue}
          value={value}
          multiline
          scrollEnabled
          maxLength={8000}
          blurOnSubmit={false}
          submitBehavior="newline"
          style={composer.input}
        />
        {sendOn ? (
          <View style={composer.trail}>
            <Pressable
              onPressIn={keepFocus}
              onPress={submit}
              accessibilityLabel="Send message"
              style={composer.send}
            >
              <SymbolView
                name="arrow.up"
                size={17}
                weight="bold"
                tintColor="#ffffff"
              />
            </Pressable>
          </View>
        ) : null}
      </GlassView>
      </View>
    </View>
  );
}

const FIELD = 44;
const SEND = 34;
const FIELD_MAX = 22 * 6 + 22;
const composer = StyleSheet.create({
  column: { paddingHorizontal: 12, gap: 8 },
  files: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  file: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 220,
    height: 32,
    paddingLeft: 12,
    paddingRight: 10,
    borderRadius: 16,
    backgroundColor: color.secondary,
  },
  fileName: { flexShrink: 1, fontSize: 14, color: color.text },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
  },
  plus: {
    width: FIELD,
    height: FIELD,
    alignItems: "center",
    justifyContent: "center",
  },
  plusGlass: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: FIELD / 2,
  },
  field: {
    flex: 1,
    minHeight: FIELD,
    maxHeight: FIELD_MAX,
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: FIELD / 2,
    overflow: "hidden",
  },
  input: {
    flex: 1,
    minHeight: FIELD,
    maxHeight: FIELD_MAX,
    paddingLeft: 16,
    paddingRight: 4,
    paddingTop: 11,
    paddingBottom: 11,
    fontSize: 17,
    lineHeight: 22,
    color: color.text,
  },
  trail: {
    width: FIELD,
    height: FIELD,
    alignItems: "center",
    justifyContent: "center",
  },
  send: {
    width: SEND,
    height: SEND,
    borderRadius: SEND / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#8E8E93",
  },
});

function avatarRadius(shape: "human" | "agent" | "channel") {
  if (shape === "channel") return { borderRadius: 12 };
  if (shape === "agent")
    return {
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderBottomRightRadius: 20,
      borderBottomLeftRadius: 8,
    };
  return { borderRadius: 999 };
}

export function AvatarView({
  avatar,
  name,
  shape = "human",
  size = 44,
}: {
  avatar?: Avatar | null;
  name: string;
  shape?: "human" | "agent" | "channel";
  size?: number;
}) {
  const glass = Boolean(
    avatar?.url && avatar.kind !== "uploaded" && shape !== "agent",
  );
  const layers = useGlassAvatar(avatar?.url, glass);
  const radius = avatarRadius(shape);
  return (
    <View
      style={[
        styles.avatar,
        radius,
        { width: size, height: size },
        layers ? { backgroundColor: layers.bg } : null,
      ]}
    >
      {glass ? (
        layers ? (
          <>
            <Image
              source={layers.baseUri}
              blurRadius={GLASS_BLUR_RADIUS}
              enforceEarlyResizing
              contentFit="fill"
              cachePolicy="memory-disk"
              style={styles.glassBlur}
            />
            {layers.iconUri ? (
              <Image
                source={layers.iconUri}
                contentFit="fill"
                cachePolicy="memory-disk"
                style={[StyleSheet.absoluteFill, radius]}
              />
            ) : null}
          </>
        ) : (
          <Text
            style={[
              styles.initial,
              { fontSize: Math.round((18 * size) / 44) },
            ]}
          >
            {name.slice(0, 1).toUpperCase()}
          </Text>
        )
      ) : avatar?.url ? (
        <Image
          source={avatar.url}
          style={[StyleSheet.absoluteFill, radius]}
          contentFit={avatar.kind === "uploaded" ? "cover" : "fill"}
          cachePolicy="memory-disk"
        />
      ) : (
        <Text
          style={[styles.initial, { fontSize: Math.round((18 * size) / 44) }]}
        >
          {name.slice(0, 1).toUpperCase()}
        </Text>
      )}
    </View>
  );
}

export function GlassCard({
  children,
  label,
  onPress,
  disabled = false,
}: {
  children: ReactNode;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const colorScheme = useHostColorScheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [card.press, pressed && { opacity: 0.86 }]}
    >
      <Host
        colorScheme={colorScheme}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      >
        <VStack
          modifiers={[
            frame({ maxWidth: Infinity, maxHeight: Infinity }),
            glassEffect({
              glass: { variant: "regular", interactive: true },
              shape: "roundedRectangle",
              cornerRadius: 22,
            }),
          ]}
        >
          {null}
        </VStack>
      </Host>
      <View pointerEvents="none" style={card.body}>
        {children}
      </View>
    </Pressable>
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
  grouped: {
    flex: 1,
    backgroundColor: PlatformColor("systemGroupedBackground"),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    minHeight: 64,
  },
  avatar: {
    width: 44,
    height: 44,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.secondary,
  },
  glassBlur: {
    position: "absolute",
    width: `${100 + GLASS_BLUR_PAD * 2}%`,
    height: `${100 + GLASS_BLUR_PAD * 2}%`,
    top: `-${GLASS_BLUR_PAD}%`,
    left: `-${GLASS_BLUR_PAD}%`,
  },
  initial: { fontSize: 18, fontWeight: "600", color: color.muted },
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
    marginLeft: 72,
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

const card = StyleSheet.create({
  press: { alignSelf: "stretch" },
  body: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 76,
  },
});

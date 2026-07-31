import * as Haptics from 'expo-haptics';
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SvgXml } from 'react-native-svg';

import { MaxWidthContent } from '@/components/max-width-content';
import { SheetGrabber } from '@/components/sheet-grabber';
import { useTheme } from '@/hooks/use-theme';
import { type SocialProvider } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

type Phase = 'enter-email' | 'enter-code';

/* Brand glyphs from Bootstrap Icons (MIT). Single-path monochrome shapes
 * rendered via react-native-svg so they work on both iOS and Android. */
const GOOGLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M15.545 6.558a9.42 9.42 0 0 1 .139 1.626c0 2.434-.87 4.492-2.384 5.885h.002C11.978 15.292 10.158 16 8 16A8 8 0 1 1 8 0a7.689 7.689 0 0 1 5.352 2.082l-2.284 2.284A4.347 4.347 0 0 0 8 3.166c-2.087 0-3.86 1.408-4.492 3.304a4.792 4.792 0 0 0 0 3.063h.003c.635 1.893 2.405 3.301 4.492 3.301 1.078 0 2.004-.276 2.722-.764h-.003a3.702 3.702 0 0 0 1.599-2.431H8v-3.08h7.545z"/></svg>`;
const GITHUB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

function tintSvg(svg: string, color: string): string {
  return svg.replace('<svg ', `<svg fill="${color}" `);
}

export default function SignInSheet() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { sendMagicCode, verifyMagicCode, socialSignIn } = useAuth();
  const codeInputRef = useRef<TextInput>(null);

  const [phase, setPhase] = useState<Phase>('enter-email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [socialBusy, setSocialBusy] = useState<SocialProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (phase === 'enter-code') {
      const t = setTimeout(() => codeInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [phase]);

  const submitEmail = async () => {
    const normalized = email.trim().toLowerCase();
    if (!normalized) {
      setError('Email required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendMagicCode(normalized);
      setEmail(normalized);
      setCode('');
      setPhase('enter-code');
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (value: string) => {
    const normalized = value.trim();
    if (normalized.length !== 6) {
      setError('Enter the 6-digit code');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verifyMagicCode(email, normalized);
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  const handleCodeChange = (next: string) => {
    const digits = next.replace(/\D/gu, '').slice(0, 6);
    setCode(digits);
    setError(null);
    if (digits.length === 6 && !busy) {
      void submitCode(digits);
    }
  };

  const resetEmail = () => {
    setPhase('enter-email');
    setCode('');
    setError(null);
  };

  const handleSocial = async (provider: SocialProvider) => {
    if (socialBusy || busy) return;
    setSocialBusy(provider);
    setError(null);
    try {
      const ok = await socialSignIn(provider);
      if (ok) {
        if (process.env.EXPO_OS === 'ios') {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        router.back();
      }
      // ok === false → user dismissed the in-app browser; stay silent.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setSocialBusy(null);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{ contentStyle: { backgroundColor: theme.background } }}
      />
      <SheetGrabber />
      <MaxWidthContent insetTopWhenLarge>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={24}
        style={styles.flex}>
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            {
              paddingBottom: Math.max(insets.bottom, 16),
              paddingLeft: Math.max(24, insets.left + 8),
              paddingRight: Math.max(24, insets.right + 8),
            },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <View style={styles.titleBlock}>
            <Text style={[styles.title, { color: theme.text }]}>
              {phase === 'enter-email' ? 'Get Started' : 'Check your email'}
            </Text>
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
              {phase === 'enter-email'
                ? 'Sign in to chat with your agents.'
                : `We sent a 6-digit code to ${email}.`}
            </Text>
          </View>

          {phase === 'enter-email' ? (
            <View style={styles.form}>
              <TextInput
                value={email}
                onChangeText={(value) => {
                  setEmail(value);
                  setError(null);
                }}
                onSubmitEditing={submitEmail}
                placeholder="you@example.com"
                placeholderTextColor={theme.textSecondary}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="send"
                editable={!busy}
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.inputBg,
                    borderColor: theme.inputBorder,
                    color: theme.text,
                  },
                ]}
              />
              <PrimaryButton
                label={busy ? 'Sending…' : 'Send Code'}
                onPress={submitEmail}
                busy={busy}
                disabled={busy || !email.trim()}
              />
            </View>
          ) : (
            <View style={styles.form}>
              <TextInput
                ref={codeInputRef}
                value={code}
                onChangeText={handleCodeChange}
                onSubmitEditing={() => submitCode(code)}
                placeholder="• • • • • •"
                placeholderTextColor={theme.textSecondary}
                keyboardType="number-pad"
                inputMode="numeric"
                autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'one-time-code'}
                textContentType="oneTimeCode"
                maxLength={6}
                returnKeyType="done"
                editable={!busy}
                style={[
                  styles.codeInput,
                  {
                    backgroundColor: theme.inputBg,
                    borderColor: theme.inputBorder,
                    color: theme.text,
                  },
                ]}
              />
              <PrimaryButton
                label={busy ? 'Verifying…' : 'Verify'}
                onPress={() => submitCode(code)}
                busy={busy}
                disabled={busy || code.length !== 6}
              />
              <Pressable
                accessibilityRole="button"
                onPress={resetEmail}
                disabled={busy}
                style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}>
                <Text style={[styles.linkText, { color: theme.textSecondary }]}>
                  Use a different email
                </Text>
              </Pressable>
            </View>
          )}

          {error ? (
            <Text style={[styles.error, { color: theme.destructive }]} selectable>
              {error}
            </Text>
          ) : null}

          {phase === 'enter-email' ? (
            <>
              <View style={styles.dividerRow}>
                <View style={[styles.dividerLine, { backgroundColor: theme.backgroundSelected }]} />
                <Text style={[styles.dividerLabel, { color: theme.textSecondary }]}>or</Text>
                <View style={[styles.dividerLine, { backgroundColor: theme.backgroundSelected }]} />
              </View>

              <View style={styles.providerRow}>
                <ProviderButton
                  svg={GOOGLE_SVG}
                  accessibilityLabel="Continue with Google"
                  onPress={() => {
                    void handleSocial('google');
                  }}
                  busy={socialBusy === 'google'}
                  disabled={busy || (socialBusy !== null && socialBusy !== 'google')}
                />
                <ProviderButton
                  svg={GITHUB_SVG}
                  accessibilityLabel="Continue with GitHub"
                  onPress={() => {
                    void handleSocial('github');
                  }}
                  busy={socialBusy === 'github'}
                  disabled={busy || (socialBusy !== null && socialBusy !== 'github')}
                />
              </View>
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
      </MaxWidthContent>
    </>
  );
}

interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}

function PrimaryButton({ label, onPress, busy, disabled }: PrimaryButtonProps): ReactNode {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.primaryButton,
        {
          backgroundColor: theme.text,
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
      ]}>
      {busy ? (
        <ActivityIndicator color={theme.background} />
      ) : (
        <Text style={[styles.primaryLabel, { color: theme.background }]}>{label}</Text>
      )}
    </Pressable>
  );
}

function ProviderButton({
  svg,
  accessibilityLabel,
  onPress,
  busy,
  disabled,
}: {
  svg: string;
  accessibilityLabel: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.providerButton,
        {
          backgroundColor: theme.inputBg,
          borderColor: theme.inputBorder,
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
      ]}>
      {busy ? (
        <ActivityIndicator color={theme.textSecondary} />
      ) : (
        <SvgXml xml={tintSvg(svg, theme.textSecondary)} width={26} height={26} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  codeInput: {
    borderRadius: 36,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 30,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    height: 76,
    letterSpacing: 10,
    paddingHorizontal: 22,
    textAlign: 'center',
  },
  dividerLabel: {
    fontSize: 13,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    marginTop: 32,
  },
  error: {
    fontSize: 13,
    marginTop: 14,
    textAlign: 'center',
  },
  flex: {
    flex: 1,
  },
  form: {
    gap: 16,
    marginTop: 28,
  },
  input: {
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 17,
    height: 60,
    letterSpacing: 0,
    paddingHorizontal: 22,
  },
  linkButton: {
    alignItems: 'center',
    minHeight: 40,
    paddingVertical: 10,
  },
  linkText: {
    fontSize: 14,
    fontWeight: '500',
  },
  pressed: {
    opacity: 0.6,
  },
  primaryButton: {
    alignItems: 'center',
    borderRadius: 999,
    height: 60,
    justifyContent: 'center',
    width: '100%',
  },
  primaryLabel: {
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  providerButton: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    height: 60,
    justifyContent: 'center',
  },
  providerRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  scroll: {
    paddingTop: 24,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  titleBlock: {
    gap: 6,
    paddingHorizontal: 8,
  },
});

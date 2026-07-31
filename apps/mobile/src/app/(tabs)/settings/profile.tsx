import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { Stack } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import { MaxWidthContent } from '@/components/max-width-content';
import { useTheme } from '@/hooks/use-theme';
import { resetMyAvatar, updateMe, uploadMyAvatar } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

const SECTION_RADIUS = 22;
const AVATAR_SIZE = 96;

interface DisplayNameDraft {
  source: string;
  value: string;
}

function formatMemberSince(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diff = Date.now() - then;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) {
    const m = Math.floor(diff / 60_000);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (diff < 86_400_000) {
    const h = Math.floor(diff / 3_600_000);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(diff / 86_400_000);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

export default function ProfileScreen() {
  const theme = useTheme();
  const { token, user, patchUser, deleteAccount } = useAuth();
  const queryClient = useQueryClient();
  const headerHeight = useHeaderHeight();
  const androidHeaderPad = Platform.OS === 'android' ? headerHeight : 0;
  const sourceDisplayName = user?.display_name ?? '';

  const [displayNameDraft, setDisplayNameDraft] = useState<DisplayNameDraft>(() => ({
    source: sourceDisplayName,
    value: sourceDisplayName,
  }));
  const [savingName, setSavingName] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memberSince = useMemo(() => formatMemberSince(user?.created_at), [user?.created_at]);
  const lastActive = useMemo(() => formatRelativeTime(user?.last_seen_at), [user?.last_seen_at]);
  const hasCustomAvatar = user?.avatar?.kind === 'uploaded';
  const displayName =
    displayNameDraft.source === sourceDisplayName ? displayNameDraft.value : sourceDisplayName;

  const trimmedName = displayName.trim();
  const initialName = sourceDisplayName.trim();
  const dirty = trimmedName !== initialName;

  const setDisplayName = (value: string) => {
    setDisplayNameDraft({ source: sourceDisplayName, value });
  };

  const saveName = async () => {
    if (savingName || !dirty) return;
    setSavingName(true);
    setError(null);
    try {
      const next = trimmedName.length === 0 ? null : trimmedName;
      const updated = await updateMe(token, next);
      patchUser({ display_name: updated.display_name, avatar: updated.avatar });
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save profile');
    } finally {
      setSavingName(false);
    }
  };

  const pickAvatar = async () => {
    if (avatarBusy) return;
    setError(null);
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      if (picked.canceled) return;
      const asset = picked.assets[0];
      if (!asset) return;
      setAvatarBusy(true);
      const filename = asset.fileName ?? asset.uri.split('/').pop() ?? 'avatar.jpg';
      const guessedType =
        asset.mimeType ??
        (filename.match(/\.(\w+)$/)?.[1]?.toLowerCase() === 'png'
          ? 'image/png'
          : 'image/jpeg');
      const ref = await uploadMyAvatar(token, {
        uri: asset.uri,
        name: filename,
        type: guessedType,
      });
      patchUser({ avatar: ref });
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload avatar');
    } finally {
      setAvatarBusy(false);
    }
  };

  const resetAvatar = async () => {
    if (avatarBusy) return;
    setAvatarBusy(true);
    setError(null);
    try {
      const ref = await resetMyAvatar(token);
      patchUser({ avatar: ref });
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset avatar');
    } finally {
      setAvatarBusy(false);
    }
  };

  const presentAvatarMenu = () => {
    if (avatarBusy) return;
    const options = hasCustomAvatar
      ? ['Cancel', 'Choose Photo', 'Reset to Default']
      : ['Cancel', 'Choose Photo'];
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: 0,
          destructiveButtonIndex: hasCustomAvatar ? 2 : undefined,
        },
        (idx) => {
          if (idx === 1) void pickAvatar();
          else if (idx === 2 && hasCustomAvatar) void resetAvatar();
        },
      );
    } else {
      const buttons: { text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }[] = [
        { text: 'Choose Photo', onPress: () => void pickAvatar() },
      ];
      if (hasCustomAvatar) {
        buttons.push({
          text: 'Reset to Default',
          style: 'destructive',
          onPress: () => void resetAvatar(),
        });
      }
      buttons.push({ text: 'Cancel', style: 'cancel' });
      Alert.alert('Avatar', undefined, buttons);
    }
  };

  const runDeleteAccount = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteAccount();
      // On success the auth provider tears down the session and flips
      // status to 'anonymous', so this screen unmounts to the signed-out
      // surface — nothing more to do here.
    } catch (err) {
      // 409 guard ("remove your agents first" / "transfer org ownership")
      // or a network error: surface the backend's reason verbatim and keep
      // the still-valid session intact.
      const msg = err instanceof Error ? err.message : 'Could not delete account';
      setError(msg);
      Alert.alert("Couldn't delete account", msg);
      setDeleting(false);
    }
  };

  const confirmDeleteAccount = () => {
    if (deleting) return;
    Alert.alert(
      'Delete account?',
      "This permanently deletes your account and all of your data — messages, reactions, files, and any chat where you're the only member. This can't be undone.\n\nIf you operate agents or solely own a shared organization, hand those off first.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Account',
          style: 'destructive',
          onPress: () => void runDeleteAccount(),
        },
      ],
    );
  };

  if (!user) {
    return (
      <View style={[styles.screen, styles.centered, { backgroundColor: theme.background }]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Profile', headerBackTitle: 'Settings' }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.screen, { backgroundColor: theme.background }]}>
        <MaxWidthContent maxWidth={720}>
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: androidHeaderPad + 12 },
          ]}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled">
          <View style={styles.heroBlock}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change avatar"
              onPress={presentAvatarMenu}
              disabled={avatarBusy}
              style={({ pressed }) => [styles.avatarWrap, pressed && styles.pressed]}>
              <Avatar
                uri={user.avatar?.url}
                name={user.display_name ?? user.email}
                size={AVATAR_SIZE}
              />
              <View style={[styles.cameraBadge, { backgroundColor: theme.text }]}>
                {avatarBusy ? (
                  <ActivityIndicator size="small" color={theme.background} />
                ) : (
                  <SymbolView
                    name={{ ios: 'camera.fill', android: 'photo_camera' }}
                    size={14}
                    tintColor={theme.background}
                    weight="semibold"
                  />
                )}
              </View>
            </Pressable>
            <Text style={[styles.heroHint, { color: theme.textSecondary }]}>
              Tap the avatar to change or reset it
            </Text>
          </View>

          <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>
            Identity
          </Text>
          <View style={[styles.section, { backgroundColor: theme.backgroundElement }]}>
            <View style={styles.fieldRow}>
              <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>
                Display name
              </Text>
              <TextInput
                value={displayName}
                onChangeText={setDisplayName}
                onBlur={() => void saveName()}
                placeholder="Add a display name"
                placeholderTextColor={theme.textSecondary}
                autoCapitalize="words"
                returnKeyType="done"
                maxLength={200}
                onSubmitEditing={() => void saveName()}
                style={[
                  styles.fieldInput,
                  { color: theme.text, borderBottomColor: theme.backgroundSelected },
                ]}
              />
              <Text style={[styles.fieldHint, { color: theme.textSecondary }]}>
                Shown next to your messages. Leave blank to fall back to your email.
              </Text>
            </View>

            <View style={[styles.fieldRow, styles.fieldRowLast]}>
              <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>
                Email
              </Text>
              <Text style={[styles.fieldStatic, { color: theme.text }]} selectable>
                {user.email}
              </Text>
              <Text style={[styles.fieldHint, { color: theme.textSecondary }]}>
                Email is managed by your auth provider and can&apos;t be changed here.
              </Text>
            </View>
          </View>

          {error ? (
            <Text style={[styles.error, { color: theme.destructive }]} selectable>
              {error}
            </Text>
          ) : null}
          {savingName ? (
            <Text style={[styles.savingHint, { color: theme.textSecondary }]}>
              Saving…
            </Text>
          ) : null}

          <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>
            Account
          </Text>
          <View style={[styles.section, { backgroundColor: theme.backgroundElement }]}>
            <MetaRow label="Member since" value={memberSince ?? '—'} />
            <MetaRow label="Last active" value={lastActive ?? '—'} />
            <MetaRow label="User ID" value={String(user.id)} monospace last />
          </View>

          <Text style={[styles.sectionHeader, styles.dangerHeader, { color: theme.destructive }]}>
            Danger zone
          </Text>
          <View style={[styles.section, { backgroundColor: theme.backgroundElement }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete account"
              onPress={confirmDeleteAccount}
              disabled={deleting}
              style={({ pressed }) => [styles.dangerRow, pressed && styles.pressed]}>
              {deleting ? (
                <ActivityIndicator size="small" color={theme.destructive} />
              ) : (
                <SymbolView
                  name={{ ios: 'trash.fill', android: 'delete' }}
                  size={18}
                  tintColor={theme.destructive}
                  weight="semibold"
                />
              )}
              <Text style={[styles.dangerLabel, { color: theme.destructive }]}>
                {deleting ? 'Deleting…' : 'Delete account'}
              </Text>
            </Pressable>
          </View>
          <Text style={[styles.dangerHint, { color: theme.textSecondary }]}>
            Permanently deletes your account and all your data. This can&apos;t be undone.
          </Text>
        </ScrollView>
        </MaxWidthContent>
      </KeyboardAvoidingView>
    </>
  );
}

function MetaRow({
  label,
  value,
  monospace,
  last,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  last?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.metaRow,
        !last && {
          borderBottomColor: theme.backgroundSelected,
          borderBottomWidth: StyleSheet.hairlineWidth,
        },
      ]}>
      <Text style={[styles.metaLabel, { color: theme.textSecondary }]}>{label}</Text>
      <Text
        style={[styles.metaValue, { color: theme.text }, monospace && styles.mono]}
        selectable
        numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatarWrap: {
    alignItems: 'center',
    height: AVATAR_SIZE,
    justifyContent: 'center',
    position: 'relative',
    width: AVATAR_SIZE,
  },
  cameraBadge: {
    alignItems: 'center',
    borderRadius: 14,
    bottom: -2,
    height: 28,
    justifyContent: 'center',
    position: 'absolute',
    right: -2,
    width: 28,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerHeader: {
    marginTop: 8,
  },
  dangerHint: {
    fontSize: 12,
    lineHeight: 16,
    marginHorizontal: 8,
    marginTop: -8,
  },
  dangerLabel: {
    fontSize: 17,
    fontWeight: '600',
  },
  dangerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  error: {
    fontSize: 13,
    marginBottom: 12,
    marginHorizontal: 8,
    marginTop: -8,
  },
  fieldHint: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 6,
  },
  fieldInput: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    fontSize: 17,
    paddingBottom: 8,
    paddingTop: 2,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
  },
  fieldRow: {
    borderBottomColor: 'transparent',
    borderBottomWidth: StyleSheet.hairlineWidth,
    padding: 16,
  },
  fieldRowLast: {
    borderBottomWidth: 0,
  },
  fieldStatic: {
    fontSize: 17,
    paddingBottom: 8,
    paddingTop: 2,
  },
  heroBlock: {
    alignItems: 'center',
    gap: 10,
    paddingBottom: 24,
    paddingTop: 8,
  },
  heroHint: {
    fontSize: 13,
  },
  metaLabel: {
    flex: 1,
    fontSize: 15,
  },
  metaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  metaValue: {
    fontSize: 15,
    marginLeft: 12,
    textAlign: 'right',
  },
  mono: {
    fontFamily: Platform.select({ ios: 'ui-monospace', android: 'monospace', default: 'monospace' }),
    fontSize: 13,
  },
  pressed: {
    opacity: 0.7,
  },
  savingHint: {
    fontSize: 12,
    marginBottom: 12,
    marginHorizontal: 8,
    marginTop: -8,
  },
  screen: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 96,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  section: {
    borderRadius: SECTION_RADIUS,
    marginBottom: 16,
    overflow: 'hidden',
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: -0.1,
    marginBottom: 8,
    marginLeft: 4,
  },
});

import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router, Stack } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
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

import { Avatar } from '@/components/avatar';
import { MaxWidthContent } from '@/components/max-width-content';
import { SheetGrabber } from '@/components/sheet-grabber';
import { useTheme } from '@/hooks/use-theme';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import {
  addMmChannelMember,
  createMmChannel,
  listOrgAgents,
  listOrgMembers,
  type AgentUser,
  type MmMemberType,
  type OrgMember,
} from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

const IMESSAGE_BLUE = '#0A84FF';

interface Invitee {
  kind: MmMemberType;
  id: string;
  label: string;
  sub: string;
  avatarUrl?: string | null;
}

const inviteeKey = (i: Invitee) => `${i.kind}:${i.id}`;

/** Mirrors the web slugifier — server requires a kebab-case ``name``
 *  for the channel slug; ``display_name`` keeps the user's casing. */
function slugify(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `channel-${String(Date.now())}`;
}

export default function NewChannelSheet() {
  const theme = useTheme();
  const { token, user } = useAuth();
  const { selectedOrg } = useSelectedOrg();
  const queryClient = useQueryClient();
  const orgId = selectedOrg?.org_id ?? null;

  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const membersQuery = useQuery({
    queryKey: ['org-members', orgId],
    queryFn: () => listOrgMembers(token, orgId!),
    enabled: token != null && orgId != null,
  });
  const agentsQuery = useQuery({
    queryKey: ['org-agents', orgId],
    queryFn: () => listOrgAgents(token, orgId!),
    enabled: token != null && orgId != null,
  });

  const invitees = useMemo<Invitee[]>(() => {
    const humans = (membersQuery.data?.members ?? [])
      .filter((m: OrgMember) => m.human_id !== user?.id)
      .map<Invitee>((m) => ({
        kind: 'human',
        id: String(m.human_id),
        label: m.display_name ?? m.email,
        sub: m.email,
        avatarUrl: m.avatar?.url,
      }));
    const agents = (agentsQuery.data?.agents ?? []).map<Invitee>((a: AgentUser) => ({
      kind: 'agent',
      id: a.agent_id,
      label: a.display_name ?? a.nickname ?? a.agent_id,
      sub: 'Agent',
      avatarUrl: a.avatar?.url,
    }));
    return [...agents, ...humans];
  }, [agentsQuery.data, membersQuery.data, user?.id]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return invitees;
    return invitees.filter(
      (i) => i.label.toLowerCase().includes(q) || i.sub.toLowerCase().includes(q),
    );
  }, [invitees, query]);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const trimmed = name.trim();

  const submit = async () => {
    if (!trimmed || !orgId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const channel = await createMmChannel(
        token,
        orgId,
        slugify(trimmed),
        trimmed,
        visibility,
      );
      const toInvite = invitees.filter((i) => selected.has(inviteeKey(i)));
      // Serial adds — the server returns the full member list after each
      // one and a parallel firehose would clobber state without changing
      // the user-visible outcome.
      for (const i of toInvite) {
        try {
          await addMmChannelMember(token, channel.channel_id, i.id, i.kind);
        } catch {
          // Swallow individual invite failures — the channel exists; the
          // owner can re-invite from the channel screen.
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      router.back();
      setTimeout(() => {
        router.push({
          pathname: '/chats/[channelId]',
          params: { channelId: channel.channel_id },
        });
      }, 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create channel");
      setSubmitting(false);
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
        style={styles.flex}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <View style={styles.titleBlock}>
            <Text style={[styles.title, { color: theme.text }]}>Create channel</Text>
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
              Channels organize conversations around a topic. Invite people now or
              add them later.
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>
              Channel name
            </Text>
            <TextInput
              value={name}
              onChangeText={(v) => {
                setName(v);
                setError(null);
              }}
              placeholder="e.g. general"
              placeholderTextColor={theme.textSecondary}
              maxLength={64}
              editable={!submitting}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.input,
                {
                  backgroundColor: theme.inputBg,
                  borderColor: theme.inputBorder,
                  color: theme.text,
                },
              ]}
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>
              Visibility
            </Text>
            <View style={styles.visibilityRow}>
              <VisibilityOption
                label="Public"
                description="Anyone in the org can join"
                symbol={{ ios: 'number', android: 'tag' }}
                selected={visibility === 'public'}
                disabled={submitting}
                onPress={() => setVisibility('public')}
              />
              <VisibilityOption
                label="Private"
                description="Invite-only"
                symbol={{ ios: 'lock.fill', android: 'lock' }}
                selected={visibility === 'private'}
                disabled={submitting}
                onPress={() => setVisibility('private')}
              />
            </View>
          </View>

          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>
              Invite people{selected.size > 0 ? ` (${selected.size} selected)` : ''}
            </Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search agents and people…"
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!submitting}
              style={[
                styles.input,
                {
                  backgroundColor: theme.inputBg,
                  borderColor: theme.inputBorder,
                  color: theme.text,
                },
              ]}
            />
            <View style={[styles.list, { backgroundColor: theme.backgroundElement }]}>
              {filtered.length === 0 ? (
                <Text
                  style={[styles.emptyText, { color: theme.textSecondary }]}>
                  {invitees.length === 0
                    ? 'No one else in this organization yet.'
                    : 'No matches.'}
                </Text>
              ) : (
                filtered.map((i, idx) => {
                  const key = inviteeKey(i);
                  const isSelected = selected.has(key);
                  const isLast = idx === filtered.length - 1;
                  return (
                    <Pressable
                      key={key}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                      onPress={() => toggle(key)}
                      disabled={submitting}
                      style={({ pressed }) => [
                        styles.row,
                        pressed && styles.rowPressed,
                      ]}>
                      <Avatar uri={i.avatarUrl} name={i.label} size={32} />
                      <View style={styles.rowBody}>
                        <Text
                          style={[styles.rowLabel, { color: theme.text }]}
                          numberOfLines={1}>
                          {i.label}
                        </Text>
                        <Text
                          style={[styles.rowSub, { color: theme.textSecondary }]}
                          numberOfLines={1}>
                          {i.sub}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.checkbox,
                          {
                            backgroundColor: isSelected ? IMESSAGE_BLUE : 'transparent',
                            borderColor: isSelected ? IMESSAGE_BLUE : theme.inputBorder,
                          },
                        ]}>
                        {isSelected ? (
                          <SymbolView
                            name={{ ios: 'checkmark', android: 'check' }}
                            tintColor="#ffffff"
                            size={11}
                            weight="bold"
                          />
                        ) : null}
                      </View>
                      {!isLast ? (
                        <View
                          style={[
                            styles.divider,
                            { backgroundColor: theme.backgroundSelected },
                          ]}
                        />
                      ) : null}
                    </Pressable>
                  );
                })
              )}
            </View>
          </View>

          {error ? (
            <Text style={[styles.error, { color: theme.destructive }]} selectable>
              {error}
            </Text>
          ) : null}

          <Pressable
            accessibilityRole="button"
            onPress={() => void submit()}
            disabled={!trimmed || submitting}
            style={({ pressed }) => [
              styles.submit,
              {
                backgroundColor: theme.text,
                opacity: !trimmed || submitting ? 0.4 : pressed ? 0.85 : 1,
              },
            ]}>
            {submitting ? (
              <ActivityIndicator color={theme.background} />
            ) : (
              <Text style={[styles.submitLabel, { color: theme.background }]}>
                Create channel
              </Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
      </MaxWidthContent>
    </>
  );
}

function VisibilityOption({
  label,
  description,
  symbol,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  description: string;
  symbol: Parameters<typeof SymbolView>[0]['name'];
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.visOption,
        {
          backgroundColor: selected ? `${IMESSAGE_BLUE}1A` : theme.backgroundElement,
          borderColor: selected ? IMESSAGE_BLUE : theme.inputBorder,
          opacity: pressed ? 0.7 : 1,
        },
      ]}>
      <View style={styles.visHeader}>
        <SymbolView
          name={symbol}
          size={14}
          tintColor={selected ? IMESSAGE_BLUE : theme.text}
          weight="semibold"
        />
        <Text
          style={[
            styles.visLabel,
            { color: selected ? IMESSAGE_BLUE : theme.text },
          ]}>
          {label}
        </Text>
      </View>
      <Text style={[styles.visDescription, { color: theme.textSecondary }]}>
        {description}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  checkbox: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1.5,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  divider: {
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    left: 56,
    position: 'absolute',
    right: 14,
  },
  emptyText: {
    fontSize: 13,
    paddingVertical: 24,
    textAlign: 'center',
  },
  error: {
    fontSize: 13,
    marginTop: 4,
    textAlign: 'center',
  },
  field: {
    gap: 8,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '500',
    paddingHorizontal: 4,
  },
  flex: {
    flex: 1,
  },
  input: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    height: 48,
    paddingHorizontal: 16,
  },
  list: {
    borderRadius: 14,
    marginTop: 8,
    maxHeight: 280,
    overflow: 'hidden',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    position: 'relative',
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  rowPressed: {
    opacity: 0.6,
  },
  rowSub: {
    fontSize: 12,
    marginTop: 1,
  },
  scroll: {
    gap: 18,
    paddingBottom: 40,
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  submit: {
    alignItems: 'center',
    borderRadius: 999,
    height: 52,
    justifyContent: 'center',
    marginTop: 4,
  },
  submitLabel: {
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 19,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  titleBlock: {
    gap: 4,
    paddingHorizontal: 4,
  },
  visDescription: {
    fontSize: 11,
    lineHeight: 14,
  },
  visHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  visLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  visOption: {
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    gap: 4,
    padding: 12,
  },
  visibilityRow: {
    flexDirection: 'row',
    gap: 10,
  },
});

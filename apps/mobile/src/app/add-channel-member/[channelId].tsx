import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
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
import { useChannelMembers } from '@/hooks/use-channel-members';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import { useTheme } from '@/hooks/use-theme';
import {
  addMmChannelMember,
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

/**
 * "Add to channel" sheet — opened from the chat-details action row's
 * Add button. Lists everyone in the org (humans + agents) who is not
 * already a channel member; multi-select like new-channel's invite
 * step. Submitting fires per-invitee POSTs serially (the server
 * returns the full member list each time, parallel calls would
 * clobber state without changing the outcome).
 *
 * On success: invalidates ``mm-channel-members`` so the chat-details
 * sheet under this one re-renders with the new count, then dismisses.
 * Failed individual invites are surfaced as an error string but don't
 * block the success of the others — same forgiveness model as the
 * new-channel flow.
 */
export default function AddChannelMemberSheet() {
  const { channelId: rawChannelId } = useLocalSearchParams<{ channelId: string }>();
  const channelId = rawChannelId ?? '';
  const theme = useTheme();
  const { token, user } = useAuth();
  const { selectedOrg } = useSelectedOrg();
  const orgId = selectedOrg?.org_id ?? null;
  const queryClient = useQueryClient();

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
  // Existing channel members feed the filter below — we hide rows for
  // anyone who's already in the channel so the picker only shows
  // useful candidates. Falls back to "empty set" while the query is
  // still in flight, which means a freshly-cold cache may briefly
  // show already-joined members until the list resolves; tapping one
  // of those would get a 409 from the server which we surface as the
  // ``error`` string.
  const existingMembers = useChannelMembers(channelId);

  const existingHumanIds = useMemo(
    () => new Set(existingMembers.filter((m) => m.human_id != null).map((m) => String(m.human_id))),
    [existingMembers],
  );
  const existingAgentIds = useMemo(
    () => new Set(existingMembers.filter((m) => m.agent_id != null).map((m) => m.agent_id!)),
    [existingMembers],
  );

  const invitees = useMemo<Invitee[]>(() => {
    const humans = (membersQuery.data?.members ?? [])
      .filter((m: OrgMember) => m.human_id !== user?.id)
      .filter((m: OrgMember) => !existingHumanIds.has(String(m.human_id)))
      .map<Invitee>((m) => ({
        kind: 'human',
        id: String(m.human_id),
        label: m.display_name ?? m.email,
        sub: m.email,
        avatarUrl: m.avatar?.url,
      }));
    const agents = (agentsQuery.data?.agents ?? [])
      .filter((a: AgentUser) => !existingAgentIds.has(a.agent_id))
      .map<Invitee>((a: AgentUser) => ({
        kind: 'agent',
        id: a.agent_id,
        label: a.display_name ?? a.nickname ?? a.agent_id,
        sub: 'Agent',
        avatarUrl: a.avatar?.url,
      }));
    return [...agents, ...humans];
  }, [agentsQuery.data, membersQuery.data, user?.id, existingHumanIds, existingAgentIds]);

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

  const submit = async () => {
    if (selected.size === 0 || submitting || !channelId) return;
    setSubmitting(true);
    setError(null);
    const picked = invitees.filter((i) => selected.has(inviteeKey(i)));
    let failures = 0;
    for (const i of picked) {
      try {
        await addMmChannelMember(token, channelId, i.id, i.kind);
      } catch {
        failures += 1;
      }
    }
    // Refresh the chat-details surfaces under this sheet — the
    // members tab and the "X members" count both read from this key.
    void queryClient.invalidateQueries({ queryKey: ['mm-channel-members', channelId] });

    if (failures > 0 && failures === picked.length) {
      setError("Couldn't add any of the selected members. Try again.");
      setSubmitting(false);
      return;
    }
    if (process.env.EXPO_OS === 'ios') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    router.back();
  };

  const buttonLabel =
    selected.size === 0
      ? 'Add to channel'
      : selected.size === 1
        ? 'Add 1 person'
        : `Add ${selected.size} people`;

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
              <Text style={[styles.title, { color: theme.text }]}>Add to channel</Text>
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
                Invite agents and people from your organization to this channel.
              </Text>
            </View>

            <View style={styles.field}>
              <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>
                {selected.size > 0
                  ? `${selected.size} selected`
                  : 'Pick someone'}
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
                      ? 'Everyone in the org is already in this channel.'
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
              disabled={selected.size === 0 || submitting}
              style={({ pressed }) => [
                styles.submit,
                {
                  backgroundColor: theme.text,
                  opacity:
                    selected.size === 0 || submitting
                      ? 0.4
                      : pressed
                        ? 0.85
                        : 1,
                },
              ]}>
              {submitting ? (
                <ActivityIndicator color={theme.background} />
              ) : (
                <Text style={[styles.submitLabel, { color: theme.background }]}>
                  {buttonLabel}
                </Text>
              )}
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </MaxWidthContent>
    </>
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
    maxHeight: 360,
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
});

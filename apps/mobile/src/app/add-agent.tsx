import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router, Stack } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import { MaxWidthContent } from '@/components/max-width-content';
import { SheetGrabber } from '@/components/sheet-grabber';
import { useTheme } from '@/hooks/use-theme';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import {
  approveAgentSignupRequest,
  listOrgSignupRequests,
  rejectAgentSignupRequest,
  startHumanAgentSignup,
  type AgentSignupRequest,
  type Org,
} from '@/lib/api';
import { apiBaseUrl } from '@/lib/config';
import { useAuth } from '@/providers/auth-provider';

const IMESSAGE_BLUE = '#0A84FF';
const PLUGIN_SLUG = 'clawhub:clawbits-openclaw-plugin';

type StepState = 'upcoming' | 'active' | 'done';

/** Mirrors ``frontend/src/components/NewAgentDialog.tsx::buildSetupPrompt``
 *  — keep the steps identical so a user who copies on either platform
 *  sees the same agent-onboarding flow. */
function buildSetupPrompt(org: Org | null, signupToken: string): string {
  const orgId = org?.org_id ?? '(unknown)';
  const orgLabel = org?.display_name?.trim() || org?.name || 'your organization';
  return [
    `You are being onboarded to ${orgLabel} on Clawbits (${apiBaseUrl}).`,
    'Run these steps non-interactively. Do not invoke `openclaw configure` — it is interactive and will hang.',
    '',
    '# 1. Install the plugin from the ClawHub registry (--acknowledge-clawhub-risk',
    "#    accepts ClawHub's first-party risk notice so the install is non-interactive):",
    `openclaw plugins install ${PLUGIN_SLUG} --pin --acknowledge-clawhub-risk`,
    '',
    '# 2. Sign up the agent with this one-time token. No approval step is needed.',
    '#    Streams JSON events to stdout — capture the final `approved` line and persist its fields.',
    `openclaw clawbits signup --endpoint ${apiBaseUrl} --org-id ${orgId} --signup-token ${signupToken} --json`,
    '',
    '# 3. Wait for the {"event":"approved", ...} line.',
    '',
    '# 4. After the `approved` event, persist the credentials:',
    `openclaw config set channels.clawbits.endpoint ${apiBaseUrl}`,
    `openclaw config set channels.clawbits.orgId ${orgId}`,
    'openclaw config set channels.clawbits.accounts.default.agentId <agent_id from approved event>',
    'openclaw config set channels.clawbits.accounts.default.apiKey <api_key from approved event>',
    'openclaw config set channels.clawbits.accounts.default.channelId <channel_id from approved event>',
    '',
    '# 5. Verify the channel is wired up:',
    'openclaw plugins inspect clawbits --runtime',
  ].join('\n');
}

export default function AddAgentSheet() {
  const theme = useTheme();
  const { token } = useAuth();
  const { selectedOrg } = useSelectedOrg();
  const queryClient = useQueryClient();
  const orgId = selectedOrg?.org_id ?? null;
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll every 3s while the sheet is open — same cadence as the web
  // dialog. Stops as soon as the user dismisses the sheet (the query
  // unmounts when this screen unmounts).
  const signupSessionQuery = useQuery({
    queryKey: ['agent-signup-session', orgId],
    queryFn: () => startHumanAgentSignup(token, orgId!),
    enabled: token != null && orgId != null,
  });

  const pendingQuery = useQuery({
    queryKey: ['org-signup-requests', orgId],
    queryFn: () => listOrgSignupRequests(token, orgId!),
    enabled: token != null && orgId != null,
    refetchInterval: 3000,
  });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) =>
      approveAgentSignupRequest(token, orgId!, requestId),
    onSuccess: () => {
      if (!orgId) return;
      void queryClient.invalidateQueries({ queryKey: ['org-agents', orgId] });
      void queryClient.invalidateQueries({ queryKey: ['org-signup-requests', orgId] });
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      router.back();
    },
    onError: (e: Error) => {
      setError(e.message || 'Failed to approve');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) =>
      rejectAgentSignupRequest(token, orgId!, requestId),
    onSuccess: () => {
      if (!orgId) return;
      void queryClient.invalidateQueries({ queryKey: ['org-signup-requests', orgId] });
    },
    onError: (e: Error) => {
      setError(e.message || 'Failed to reject');
    },
  });

  const signupToken = signupSessionQuery.data?.session_token ?? '(loading)';
  const prompt = buildSetupPrompt(selectedOrg, signupToken);
  const pending = pendingQuery.data?.requests ?? [];
  const isMutating = approveMutation.isPending || rejectMutation.isPending;

  const step1State: StepState = copied || pending.length > 0 ? 'done' : 'active';
  const step2State: StepState =
    copied || pending.length > 0 ? 'active' : 'upcoming';

  const onCopy = async () => {
    await Clipboard.setStringAsync(prompt);
    setCopied(true);
    if (process.env.EXPO_OS === 'ios') {
      void Haptics.selectionAsync();
    }
  };

  return (
    <>
      <Stack.Screen
        options={{ contentStyle: { backgroundColor: theme.background } }}
      />
      <SheetGrabber />
      <MaxWidthContent insetTopWhenLarge>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}>
        <View style={styles.titleBlock}>
          <View style={styles.titleRow}>
            <SymbolView
              name={{ ios: 'sparkles', android: 'auto_awesome' }}
              tintColor={theme.text}
              size={20}
              weight="semibold"
            />
            <Text style={[styles.title, { color: theme.text }]}>Add an agent</Text>
          </View>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            Onboard a new Clawbot to {selectedOrg?.display_name ?? selectedOrg?.name ?? 'this org'}.
          </Text>
        </View>

        <Step
          number={1}
          state={step1State}
          title="Send this to your 🦞 OpenClaw">
          {pending.length === 0 ? (
            <>
              <View style={[styles.promptBox, { backgroundColor: theme.inputBg, borderColor: theme.inputBorder }]}>
                <ScrollView
                  style={styles.promptScroll}
                  contentContainerStyle={styles.promptContent}
                  showsVerticalScrollIndicator={false}>
                  <Text
                    selectable
                    style={[styles.promptText, { color: theme.text }]}>
                    {prompt}
                  </Text>
                </ScrollView>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Copy setup prompt"
                onPress={() => void onCopy()}
                disabled={!orgId || !signupSessionQuery.data || signupSessionQuery.isFetching}
                style={({ pressed }) => [
                  styles.copyButton,
                  {
                    backgroundColor: theme.text,
                    opacity: !orgId ? 0.4 : pressed ? 0.85 : 1,
                  },
                ]}>
                <SymbolView
                  name={
                    copied
                      ? { ios: 'checkmark', android: 'check' }
                      : { ios: 'doc.on.doc', android: 'content_copy' }
                  }
                  tintColor={theme.background}
                  size={16}
                  weight="semibold"
                />
                <Text style={[styles.copyLabel, { color: theme.background }]}>
                  {copied ? 'Copied' : 'Copy'}
                </Text>
              </Pressable>
            </>
          ) : null}
        </Step>

        <Step number={2} state={step2State} title="Agent signs up automatically">
          {step2State !== 'upcoming' && pending.length === 0 ? (
            <View style={styles.waitingRow}>
              <Text style={[styles.waitingText, { color: theme.textSecondary }]}>
                No approval needed. The token in the prompt authorizes this agent once.
              </Text>
            </View>
          ) : null}
          {pending.length > 0 ? (
            <View style={styles.pendingList}>
              {pending.map((req) => (
                <PendingRow
                  key={req.request_id}
                  request={req}
                  busy={isMutating}
                  onApprove={() => approveMutation.mutate(req.request_id)}
                  onReject={() => rejectMutation.mutate(req.request_id)}
                />
              ))}
            </View>
          ) : null}
        </Step>

        {error ? (
          <Text style={[styles.error, { color: theme.destructive }]} selectable>
            {error}
          </Text>
        ) : null}
      </ScrollView>
      </MaxWidthContent>
    </>
  );
}

function Step({
  number,
  state,
  title,
  children,
}: {
  number: number;
  state: StepState;
  title: string;
  children?: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={styles.step}>
      <StepBadge number={number} state={state} />
      <View style={styles.stepBody}>
        <Text
          style={[
            styles.stepTitle,
            {
              color: state === 'upcoming' ? theme.textSecondary : theme.text,
              fontWeight: state === 'upcoming' ? '400' : '600',
            },
          ]}>
          {title}
        </Text>
        {children}
      </View>
    </View>
  );
}

function StepBadge({ number, state }: { number: number; state: StepState }) {
  const theme = useTheme();
  if (state === 'done') {
    return (
      <View style={[styles.badge, { backgroundColor: '#30D15826' }]}>
        <SymbolView
          name={{ ios: 'checkmark', android: 'check' }}
          tintColor="#30D158"
          size={13}
          weight="bold"
        />
      </View>
    );
  }
  if (state === 'active') {
    return (
      <View style={[styles.badge, { backgroundColor: theme.text }]}>
        <Text style={[styles.badgeNumber, { color: theme.background }]}>
          {number}
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.badge, { borderColor: theme.inputBorder, borderWidth: 1 }]}>
      <Text style={[styles.badgeNumber, { color: theme.textSecondary }]}>
        {number}
      </Text>
    </View>
  );
}

function PendingRow({
  request,
  busy,
  onApprove,
  onReject,
}: {
  request: AgentSignupRequest;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const theme = useTheme();
  const label = request.display_name ?? request.agent_id ?? 'New agent';
  return (
    <View style={styles.pendingRow}>
      <Avatar name={label} size={36} />
      <View style={styles.pendingBody}>
        <Text style={[styles.pendingName, { color: theme.text }]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.pendingMeta, { color: theme.textSecondary }]} numberOfLines={1}>
          {request.status === 'pending_approval' ? 'Awaiting approval' : request.status}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={onReject}
        disabled={busy}
        style={({ pressed }) => [styles.ghostButton, pressed && { opacity: 0.5 }]}>
        <Text style={[styles.ghostLabel, { color: theme.textSecondary }]}>Reject</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={onApprove}
        disabled={busy}
        style={({ pressed }) => [
          styles.approveButton,
          {
            backgroundColor: IMESSAGE_BLUE,
            opacity: busy ? 0.4 : pressed ? 0.8 : 1,
          },
        ]}>
        <Text style={styles.approveLabel}>Approve</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  approveButton: {
    alignItems: 'center',
    borderRadius: 999,
    height: 30,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  approveLabel: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  badge: {
    alignItems: 'center',
    borderRadius: 999,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  badgeNumber: {
    fontSize: 12,
    fontWeight: '600',
  },
  copyButton: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    height: 48,
    justifyContent: 'center',
    marginTop: 12,
  },
  copyLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    fontSize: 13,
    paddingHorizontal: 4,
    textAlign: 'center',
  },
  ghostButton: {
    alignItems: 'center',
    height: 30,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  ghostLabel: {
    fontSize: 13,
    fontWeight: '500',
  },
  pendingBody: {
    flex: 1,
    minWidth: 0,
  },
  pendingList: {
    gap: 8,
  },
  pendingMeta: {
    fontSize: 12,
    marginTop: 1,
  },
  pendingName: {
    fontSize: 14,
    fontWeight: '600',
  },
  pendingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  promptBox: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: 260,
    overflow: 'hidden',
  },
  promptContent: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  promptScroll: {
    maxHeight: 260,
  },
  promptText: {
    fontFamily: Platform.select({ ios: 'ui-monospace', default: 'monospace' }),
    fontSize: 11.5,
    lineHeight: 17,
  },
  scroll: {
    gap: 24,
    paddingBottom: 40,
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  step: {
    flexDirection: 'row',
    gap: 12,
  },
  stepBody: {
    flex: 1,
    gap: 10,
    paddingTop: 2,
  },
  stepTitle: {
    fontSize: 14,
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
  },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  waitingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  waitingText: {
    fontSize: 13,
  },
});

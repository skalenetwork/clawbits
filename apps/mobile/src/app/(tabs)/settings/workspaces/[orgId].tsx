import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import { MaxWidthContent } from '@/components/max-width-content';
import { useTheme } from '@/hooks/use-theme';
import {
  approveAgentSignupRequest,
  listOrgAgents,
  listOrgMembers,
  listOrgSignupRequests,
  rejectAgentSignupRequest,
  type AgentSignupRequest,
} from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useSelectedOrg } from '@/hooks/use-selected-org';

const SECTION_RADIUS = 22;

export default function WorkspaceDetailScreen() {
  const theme = useTheme();
  const { token } = useAuth();
  const { orgId: routeOrgId } = useLocalSearchParams<{ orgId: string }>();
  const orgId = routeOrgId ?? '';
  const { orgs } = useSelectedOrg();
  const queryClient = useQueryClient();
  const org = orgs.find((o) => o.org_id === orgId) ?? null;
  const headerHeight = useHeaderHeight();
  const androidHeaderPad = Platform.OS === 'android' ? headerHeight : 0;

  const membersQuery = useQuery({
    queryKey: ['org-members', orgId],
    queryFn: () => listOrgMembers(token, orgId),
    enabled: token != null && Boolean(orgId),
  });

  const agentsQuery = useQuery({
    queryKey: ['org-agents', orgId],
    queryFn: () => listOrgAgents(token, orgId),
    enabled: token != null && Boolean(orgId),
  });

  const signupsQuery = useQuery({
    queryKey: ['org-signups', orgId],
    queryFn: () => listOrgSignupRequests(token, orgId),
    enabled: token != null && Boolean(orgId),
  });

  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pendingRequests = (signupsQuery.data?.requests ?? []).filter(
    (r) => r.status === 'pending_approval',
  );

  const decide = async (
    request: AgentSignupRequest,
    decision: 'approve' | 'reject',
  ) => {
    if (actingId) return;
    setActingId(request.request_id);
    setError(null);
    try {
      if (decision === 'approve') {
        await approveAgentSignupRequest(token, orgId, request.request_id);
      } else {
        await rejectAgentSignupRequest(token, orgId, request.request_id);
      }
      queryClient.invalidateQueries({ queryKey: ['org-signups', orgId] });
      queryClient.invalidateQueries({ queryKey: ['org-agents', orgId] });
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${decision}`);
    } finally {
      setActingId(null);
    }
  };

  const isLoading =
    membersQuery.isLoading || agentsQuery.isLoading || signupsQuery.isLoading;

  const headerError =
    membersQuery.error?.message ?? agentsQuery.error?.message ?? signupsQuery.error?.message;

  return (
    <>
      <Stack.Screen
        options={{
          title: org?.display_name ?? org?.name ?? 'Workspace',
          headerBackTitle: 'Workspaces',
        }}
      />
      <View style={[styles.screen, { backgroundColor: theme.background }]}>
        <MaxWidthContent maxWidth={720}>
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: androidHeaderPad + 12 },
          ]}
          contentInsetAdjustmentBehavior="automatic">
          {isLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator />
            </View>
          ) : (
            <>
              {headerError ? (
                <Text style={[styles.error, { color: theme.destructive }]} selectable>
                  {headerError}
                </Text>
              ) : null}
              {error ? (
                <Text style={[styles.error, { color: theme.destructive }]} selectable>
                  {error}
                </Text>
              ) : null}

              {pendingRequests.length > 0 ? (
                <>
                  <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>
                    Pending agent approval
                  </Text>
                  <View
                    style={[styles.section, { backgroundColor: theme.backgroundElement }]}>
                    {pendingRequests.map((req, idx) => {
                      const isLast = idx === pendingRequests.length - 1;
                      const label = req.display_name ?? req.agent_id ?? 'New agent';
                      const isBusy = actingId === req.request_id;
                      return (
                        <View key={req.request_id} style={styles.row}>
                          <View style={styles.rowLeading}>
                            <Avatar name={label} size={36} />
                          </View>
                          <View
                            style={[
                              styles.rowBody,
                              !isLast && {
                                borderBottomColor: theme.backgroundSelected,
                                borderBottomWidth: StyleSheet.hairlineWidth,
                              },
                            ]}>
                            <View style={styles.rowText}>
                              <Text
                                style={[styles.rowTitle, { color: theme.text }]}
                                numberOfLines={1}>
                                {label}
                              </Text>
                              <Text
                                style={[
                                  styles.rowSubtitle,
                                  { color: theme.textSecondary },
                                ]}
                                numberOfLines={1}>
                                Requested {new Date(req.created_at).toLocaleDateString()}
                              </Text>
                            </View>
                            <View style={styles.approveActions}>
                              <Pressable
                                accessibilityRole="button"
                                disabled={Boolean(actingId)}
                                onPress={() => void decide(req, 'reject')}
                                style={({ pressed }) => [
                                  styles.actionPill,
                                  styles.rejectPill,
                                  { borderColor: theme.backgroundSelected },
                                  pressed && styles.pressed,
                                ]}>
                                <Text style={[styles.actionText, { color: theme.text }]}>
                                  Reject
                                </Text>
                              </Pressable>
                              <Pressable
                                accessibilityRole="button"
                                disabled={Boolean(actingId)}
                                onPress={() => void decide(req, 'approve')}
                                style={({ pressed }) => [
                                  styles.actionPill,
                                  styles.approvePill,
                                  { backgroundColor: theme.text },
                                  pressed && styles.pressed,
                                ]}>
                                {isBusy ? (
                                  <ActivityIndicator size="small" color={theme.background} />
                                ) : (
                                  <Text
                                    style={[
                                      styles.actionText,
                                      { color: theme.background },
                                    ]}>
                                    Approve
                                  </Text>
                                )}
                              </Pressable>
                            </View>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </>
              ) : null}

              <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>
                Members
              </Text>
              <View style={[styles.section, { backgroundColor: theme.backgroundElement }]}>
                {(membersQuery.data?.members ?? []).length === 0 ? (
                  <Text style={[styles.emptyRow, { color: theme.textSecondary }]}>
                    No members.
                  </Text>
                ) : (
                  (membersQuery.data?.members ?? []).map((m, idx, arr) => {
                    const isLast = idx === arr.length - 1;
                    return (
                      <View key={m.human_id} style={styles.row}>
                        <View style={styles.rowLeading}>
                          <Avatar
                            uri={m.avatar?.url}
                            name={m.display_name ?? m.email}
                            size={36}
                          />
                        </View>
                        <View
                          style={[
                            styles.rowBody,
                            !isLast && {
                              borderBottomColor: theme.backgroundSelected,
                              borderBottomWidth: StyleSheet.hairlineWidth,
                            },
                          ]}>
                          <View style={styles.rowText}>
                            <Text
                              style={[styles.rowTitle, { color: theme.text }]}
                              numberOfLines={1}>
                              {m.display_name ?? m.email}
                            </Text>
                            <Text
                              style={[styles.rowSubtitle, { color: theme.textSecondary }]}
                              numberOfLines={1}>
                              {m.role === 'owner' ? 'Admin · ' : ''}
                              {m.email}
                            </Text>
                          </View>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>

              <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>
                Agents
              </Text>
              <View style={[styles.section, { backgroundColor: theme.backgroundElement }]}>
                {(agentsQuery.data?.agents ?? []).length === 0 ? (
                  <Pressable
                    onPress={() =>
                      Alert.alert(
                        'No agents yet',
                        'Use the “Add agent” flow in the chats screen to invite one.',
                      )
                    }
                    style={styles.emptyRowWrap}>
                    <Text style={[styles.emptyRow, { color: theme.textSecondary }]}>
                      No agents in this workspace yet.
                    </Text>
                  </Pressable>
                ) : (
                  (agentsQuery.data?.agents ?? []).map((a, idx, arr) => {
                    const isLast = idx === arr.length - 1;
                    const label = a.display_name ?? a.nickname ?? a.agent_id;
                    return (
                      <View key={a.agent_id} style={styles.row}>
                        <View style={styles.rowLeading}>
                          <Avatar uri={a.avatar?.url} name={label} size={36} />
                        </View>
                        <View
                          style={[
                            styles.rowBody,
                            !isLast && {
                              borderBottomColor: theme.backgroundSelected,
                              borderBottomWidth: StyleSheet.hairlineWidth,
                            },
                          ]}>
                          <View style={styles.rowText}>
                            <Text
                              style={[styles.rowTitle, { color: theme.text }]}
                              numberOfLines={1}>
                              {label}
                            </Text>
                            <Text
                              style={[styles.rowSubtitle, { color: theme.textSecondary }]}
                              numberOfLines={1}>
                              Agent
                            </Text>
                          </View>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>

              <Text style={[styles.footer, { color: theme.textSecondary }]}>
                Adding or removing members is managed from the web app for now.
              </Text>
            </>
          )}
        </ScrollView>
        </MaxWidthContent>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  actionPill: {
    alignItems: 'center',
    borderRadius: 999,
    height: 32,
    justifyContent: 'center',
    minWidth: 72,
    paddingHorizontal: 14,
  },
  actionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  approveActions: {
    flexDirection: 'row',
    gap: 8,
  },
  approvePill: {},
  centered: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyRow: {
    fontSize: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  emptyRowWrap: {
    paddingVertical: 4,
  },
  error: {
    fontSize: 13,
    marginBottom: 12,
    marginHorizontal: 8,
  },
  footer: {
    fontSize: 13,
    lineHeight: 18,
    marginHorizontal: 8,
    marginTop: -8,
  },
  pressed: {
    opacity: 0.6,
  },
  rejectPill: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    paddingLeft: 16,
  },
  rowBody: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    minHeight: 56,
    paddingRight: 14,
    paddingVertical: 10,
  },
  rowLeading: {
    alignItems: 'center',
    height: 56,
    justifyContent: 'center',
    marginRight: 12,
  },
  rowSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 17,
    fontWeight: '400',
    letterSpacing: -0.2,
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

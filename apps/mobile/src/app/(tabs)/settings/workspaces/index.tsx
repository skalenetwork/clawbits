import { router, Stack } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { MaxWidthContent } from '@/components/max-width-content';
import { useTheme } from '@/hooks/use-theme';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import { useAuth } from '@/providers/auth-provider';

const SECTION_RADIUS = 22;

export default function WorkspacesScreen() {
  const theme = useTheme();
  const { selectedOrgId, setSelectedOrgId } = useAuth();
  const { orgs, isLoading, error } = useSelectedOrg();
  const headerHeight = useHeaderHeight();
  const androidHeaderPad = Platform.OS === 'android' ? headerHeight : 0;

  return (
    <>
      <Stack.Screen options={{ title: 'Workspaces', headerBackTitle: 'Settings' }} />
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
          ) : error ? (
            <Text style={[styles.error, { color: theme.destructive }]} selectable>
              {error.message}
            </Text>
          ) : orgs.length === 0 ? (
            <Text style={[styles.empty, { color: theme.textSecondary }]}>
              You&apos;re not in any workspaces yet.
            </Text>
          ) : (
            <>
              <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>
                Your workspaces
              </Text>
              <View
                style={[styles.section, { backgroundColor: theme.backgroundElement }]}>
                {orgs.map((org, idx) => {
                  const isLast = idx === orgs.length - 1;
                  const isSelected = org.org_id === selectedOrgId;
                  return (
                    <Pressable
                      key={org.org_id}
                      accessibilityRole="button"
                      onPress={() => {
                        void setSelectedOrgId(org.org_id);
                        router.push({
                          pathname: '/(tabs)/settings/workspaces/[orgId]',
                          params: { orgId: org.org_id },
                        });
                      }}
                      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                      <View style={styles.rowLeading}>
                        <Avatar name={org.display_name ?? org.name} size={36} />
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
                            {org.display_name ?? org.name}
                          </Text>
                          <Text
                            style={[styles.rowSubtitle, { color: theme.textSecondary }]}
                            numberOfLines={1}>
                            {org.is_personal ? 'Personal workspace' : 'Workspace'}
                            {isSelected ? ' · current' : ''}
                          </Text>
                        </View>
                        <Text style={[styles.chevron, { color: theme.textSecondary }]}>
                          ›
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={[styles.footer, { color: theme.textSecondary }]}>
                Tap a workspace to view members and agents. Selecting one here also
                switches the workspace used in Chats and Home.
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
  centered: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  chevron: {
    fontSize: 22,
    marginLeft: 8,
  },
  empty: {
    fontSize: 14,
    paddingVertical: 40,
    textAlign: 'center',
  },
  error: {
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 16,
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

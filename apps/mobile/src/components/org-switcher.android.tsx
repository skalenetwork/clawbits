import { Host } from '@expo/ui';
import {
  DropdownMenu,
  DropdownMenuItem,
  RNHostView,
  Row,
  Text as ComposeText,
} from '@expo/ui/jetpack-compose';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import { useAuth } from '@/providers/auth-provider';

/**
 * Material 3 dropdown menu for the user's org list. Mirrors the iOS variant
 * (`org-switcher.ios.tsx`) which uses a SwiftUI `Menu`; Android renders Compose's
 * `DropdownMenu` triggered from a Pressable in the nav bar's `headerRight` slot.
 */
export function OrgSwitcher() {
  const { selectedOrgId, setSelectedOrgId } = useAuth();
  const { orgs, selectedOrg, isLoading } = useSelectedOrg();
  const [expanded, setExpanded] = useState(false);
  const theme = useTheme();

  if (isLoading || orgs.length === 0) return null;

  const label = orgLabel(selectedOrg);

  return (
    <Host matchContents style={styles.host}>
      <DropdownMenu
        expanded={expanded}
        onDismissRequest={() => setExpanded(false)}>
        <DropdownMenu.Trigger>
          <RNHostView matchContents>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Switch workspace"
              hitSlop={10}
              onPress={() => setExpanded(true)}
              style={({ pressed }) => [
                styles.trigger,
                pressed && styles.triggerPressed,
              ]}>
              <View style={styles.triggerRow}>
                <Text style={[styles.triggerLabel, { color: theme.text }]} numberOfLines={1}>
                  {label}
                </Text>
                <SymbolView
                  name={{ ios: 'chevron.down', android: 'expand_more' }}
                  size={14}
                  tintColor={theme.text}
                  style={styles.chevron}
                />
              </View>
            </Pressable>
          </RNHostView>
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>
          {orgs.map((org) => {
            const isSelected = org.org_id === selectedOrgId;
            return (
              <DropdownMenuItem
                key={org.org_id}
                onClick={() => {
                  void setSelectedOrgId(org.org_id);
                  setExpanded(false);
                }}>
                <DropdownMenuItem.Text>
                  <ComposeText
                    style={isSelected ? { fontWeight: '700' } : undefined}>
                    {orgLabel(org)}
                  </ComposeText>
                </DropdownMenuItem.Text>
                {isSelected ? (
                  <DropdownMenuItem.LeadingIcon>
                    <Row>
                      <SymbolView
                        name={{ ios: 'checkmark', android: 'check' }}
                        size={18}
                        tintColor={theme.text}
                      />
                    </Row>
                  </DropdownMenuItem.LeadingIcon>
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenu.Items>
      </DropdownMenu>
    </Host>
  );
}

function orgLabel(org: { name: string; display_name?: string | null } | null): string {
  if (!org) return 'Workspace';
  return org.display_name?.trim() || org.name;
}

const styles = StyleSheet.create({
  chevron: {
    height: 14,
    width: 14,
  },
  host: {
    minWidth: 48,
  },
  trigger: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 48,
    paddingHorizontal: 10,
  },
  triggerLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  triggerPressed: {
    opacity: 0.6,
  },
  triggerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
});

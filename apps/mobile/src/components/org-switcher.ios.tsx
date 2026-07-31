import { Host } from '@expo/ui';
import { Button, HStack, Image, Menu, Text } from '@expo/ui/swift-ui';
import { foregroundStyle, padding, tint } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';

import { useSelectedOrg } from '@/hooks/use-selected-org';
import { useAuth } from '@/providers/auth-provider';

/**
 * Native SwiftUI Menu that drops down with the user's org list. iOS 26 renders
 * this as a real UIMenu on a UIBarButtonItem when used inside the nav bar's
 * `headerRight` slot, with liquid glass material applied automatically.
 */
export function OrgSwitcher() {
  const { setSelectedOrgId } = useAuth();
  const { orgs, selectedOrg, isLoading } = useSelectedOrg();

  if (isLoading || orgs.length === 0) return null;

  const label = orgLabel(selectedOrg);

  return (
    <Host matchContents style={styles.host}>
      <Menu
        modifiers={[tint('primary')]}
        label={
          <HStack
            spacing={6}
            alignment="center"
            modifiers={[
              padding({ horizontal: 6 }),
              foregroundStyle('primary'),
            ]}>
            <Text>{label}</Text>
            <Image
              systemName="chevron.down"
              size={11}
              color="primary"
              modifiers={[foregroundStyle('primary')]}
            />
          </HStack>
        }>
        {orgs.map((org) => {
          const isSelected = org.org_id === selectedOrg?.org_id;
          // Canonical iOS UIMenu pattern: the active row swaps its leading
          // glyph for a `checkmark` so the selection is unambiguous at a
          // glance. Unselected rows keep the workspace/personal icon.
          const systemImage = isSelected
            ? 'checkmark'
            : org.is_personal
              ? 'person.crop.circle.fill'
              : 'building.2.fill';
          return (
            <Button
              key={org.org_id}
              label={orgLabel(org)}
              systemImage={systemImage}
              onPress={() => {
                void setSelectedOrgId(org.org_id);
              }}
            />
          );
        })}
      </Menu>
    </Host>
  );
}

function orgLabel(org: { name: string; display_name?: string | null } | null): string {
  if (!org) return 'Workspace';
  return org.display_name?.trim() || org.name;
}

const styles = StyleSheet.create({
  host: {
    minWidth: 44,
  },
});
